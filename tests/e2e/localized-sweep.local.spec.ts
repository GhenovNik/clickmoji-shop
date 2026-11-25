import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type BrowserContext, type Page, type Route } from '@playwright/test';
import {
  LOCALIZED_API_ERROR_HEADER,
  LOCALIZED_API_ERROR_VALUE,
} from '../../src/lib/api-error-source';
import { E2E_AUTH_BYPASS_TOKEN, E2E_AUTH_COOKIE, E2E_LIST_ID, e2eCategory } from './fixtures/auth';

// AGE-1667 H1: phone-width (390 px) sweep of the user screens in Russian and English, on local
// fixtures only. Every /api request is intercepted; nothing leaves the machine. Opt-in:
//   LOCALIZED_SWEEP=1 SWEEP_DIR=<absolute scratch dir> npx playwright test \
//     tests/e2e/localized-sweep.local.spec.ts --project=chromium --reporter=line
// Per screen and language it writes <SWEEP_DIR>/<screen>.<locale>.png (full page) and
// <screen>.<locale>.json (visible text, document language, horizontal overflow).

const enabled = process.env.LOCALIZED_SWEEP === '1';
const outDir = process.env.SWEEP_DIR ?? '';

type Locale = 'ru' | 'en';
type Mode = 'ok' | 'empty' | 'error';
type Import = 'none' | 'error' | 'result' | 'rate' | 'large';

type Scenario = {
  auth: boolean;
  categories?: Mode;
  products?: Mode;
  listItems?: Mode;
  favorites?: Mode;
  history?: Mode;
  search?: Mode;
  importText?: Import;
  // A failing AI create: an HTML error page instead of the JSON the client expects.
  smartCreate?: 'html';
};

const messages = (locale: Locale, file: string) =>
  JSON.parse(
    readFileSync(
      path.join(process.cwd(), 'src', 'i18n', 'messages', locale, `${file}.json`),
      'utf8'
    )
  ) as Record<string, unknown>;

function lookup(tree: Record<string, unknown>, dotted: string): string {
  const value = dotted
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
      tree
    );
  if (typeof value !== 'string') throw new Error(`missing message ${dotted}`);
  return value;
}

// Names exercise each branch of the rule: a different English name, no English name, an English
// name equal to the Russian one, and a product with variants.
// The dairy category as the API returns it: both names.
const dairy = { ...e2eCategory, nameEn: 'Dairy' };
const milk = {
  id: 'e2e-milk',
  name: 'Молоко',
  nameEn: 'Milk',
  emoji: '🥛',
  isCustom: false,
  imageUrl: null,
  imageUrlEn: null,
  variants: [],
  category: dairy,
};
const products = [
  milk,
  { ...milk, id: 'e2e-bread', name: 'Хлеб бородинский', nameEn: '', emoji: '🍞' },
  { ...milk, id: 'e2e-ketchup', name: 'Кетчуп', nameEn: 'Кетчуп', emoji: '🥫' },
  { ...milk, id: 'e2e-cheese', name: 'Сыр', nameEn: 'Cheese', emoji: '🧀' },
  {
    ...milk,
    id: 'e2e-yogurt',
    name: 'Йогурт',
    nameEn: 'Yogurt',
    emoji: '🥣',
    variants: [
      {
        id: 'v-strawberry',
        name: 'Клубничный',
        nameEn: 'Strawberry',
        emoji: '🍓',
        isCustom: false,
        imageUrl: null,
        imageUrlEn: null,
      },
    ],
  },
];
const emptyCategory = {
  ...e2eCategory,
  id: 'e2e-empty',
  name: 'Бакалея',
  nameEn: 'Grocery',
  emoji: '🛒',
};
const categories = [dairy, emptyCategory];

function listItems() {
  return products.map((product, index) => ({
    id: `e2e-item-${index}`,
    isPurchased: index === 3,
    note: index === 0 ? '2 шт' : null,
    variant:
      index === 4
        ? { id: 'v-strawberry', name: 'Клубничный', nameEn: 'Strawberry', emoji: '🍓' }
        : null,
    product: {
      id: product.id,
      name: product.name,
      nameEn: product.nameEn,
      emoji: product.emoji,
      isCustom: false,
      imageUrl: null,
      imageUrlEn: null,
      category: {
        name: product.category.name,
        nameEn: product.category.nameEn,
        emoji: product.category.emoji,
        order: 1,
      },
    },
  }));
}

function favoritesFixture() {
  return [
    { id: 'fav-1', productId: 'e2e-milk', usageCount: 3, variant: null, product: products[0] },
    {
      id: 'fav-2',
      productId: 'e2e-yogurt',
      usageCount: 1,
      product: products[4],
      variant: {
        id: 'v-strawberry',
        name: 'Клубничный',
        nameEn: 'Strawberry',
        emoji: '🍓',
        imageUrl: null,
        imageUrlEn: null,
      },
    },
    { id: 'fav-3', productId: 'e2e-bread', usageCount: 1, variant: null, product: products[1] },
  ];
}

function historyFixture() {
  const addedAt = '2026-11-20T10:00:00.000Z';
  return [
    {
      id: 'hist-list-1',
      listName: 'Завтрак',
      completedAt: '2026-11-20T11:00:00.000Z',
      items: [
        {
          id: 'hi-1',
          productId: 'e2e-milk',
          variantId: null,
          productName: 'Молоко',
          productNameEn: 'Milk',
          productEmoji: '🥛',
          productImageUrl: null,
          productImageUrlEn: null,
          categoryName: 'Молочные продукты',
          categoryNameEn: 'Dairy',
          isCustom: false,
          variantName: null,
          variantNameEn: null,
          variantEmoji: null,
          note: '2 шт',
          isPurchased: true,
          addedAt,
        },
        {
          id: 'hi-2',
          productId: 'e2e-bread',
          variantId: null,
          productName: 'Хлеб бородинский',
          productNameEn: null,
          productEmoji: '🍞',
          productImageUrl: null,
          productImageUrlEn: null,
          categoryName: 'Молочные продукты',
          categoryNameEn: null,
          isCustom: false,
          variantName: null,
          variantNameEn: null,
          variantEmoji: null,
          note: null,
          isPurchased: true,
          addedAt,
        },
      ],
    },
  ];
}

// Shaped like the route's real report (app/api/lists/import-text/route.ts): a name with no English
// stays empty in the English interface, and an entry with no usable name gets the fallback in the
// request language. The route's own tests pin these values for both languages.
function importResult(locale: Locale) {
  const api = messages(locale, 'api');
  const categoryName = locale === 'en' ? 'Dairy' : 'Молочные продукты';
  const named = (product: (typeof products)[number]) =>
    locale === 'en' && product.nameEn ? product.nameEn : product.name;
  return {
    message: lookup(api, 'import.summary')
      .replace('{added}', '1')
      .replace('{created}', '1')
      .replace('{skipped}', '1')
      .replace('{failed}', '2'),
    results: {
      added: [{ name: named(products[0]), category: categoryName, note: '2 шт' }],
      created: [{ name: locale === 'en' ? 'Feta' : 'Фета', category: categoryName }],
      skipped: [{ name: named(products[3]), reason: lookup(api, 'import.entryFailed') }],
      failed: [
        {
          product: { nameRu: 'Хлеб бородинский', nameEn: '' },
          reason: lookup(api, 'import.categoryNotFound').replace(
            '{category}',
            locale === 'en' ? 'Grocery' : 'Бакалея'
          ),
        },
        {
          product: { nameRu: lookup(api, 'import.unrecognizedName'), nameEn: '' },
          reason: lookup(api, 'import.unrecognizedEntry'),
        },
      ],
    },
  };
}

async function setup(page: Page, context: BrowserContext, locale: Locale, scenario: Scenario) {
  await context.addCookies([
    { name: 'NEXT_LOCALE', value: locale, domain: 'localhost', path: '/', sameSite: 'Lax' },
  ]);
  if (scenario.auth) {
    await context.addCookies([
      {
        name: E2E_AUTH_COOKIE,
        value: E2E_AUTH_BYPASS_TOKEN,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  }

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const importError = (key: string, status: number) =>
      route.fulfill({
        status,
        headers: { [LOCALIZED_API_ERROR_HEADER]: LOCALIZED_API_ERROR_VALUE },
        contentType: 'application/json',
        body: JSON.stringify({ error: lookup(messages(locale, 'api'), key) }),
      });
    const mode = (value: Mode | undefined) => value ?? 'ok';

    if (url.pathname === '/api/auth/session') {
      return json(
        scenario.auth
          ? {
              user: { id: 'e2e-user', name: 'E2E User', email: 'e2e@example.com', role: 'USER' },
              expires: '2099-01-01T00:00:00.000Z',
            }
          : {}
      );
    }
    if (url.pathname === '/api/categories') {
      return mode(scenario.categories) === 'error'
        ? json({ error: 'error' }, 500)
        : json(categories);
    }
    if (url.pathname === '/api/products') {
      if (mode(scenario.products) === 'error') return json({ error: 'error' }, 500);
      if (mode(scenario.products) === 'empty') return json([]);
      const categoryId = url.searchParams.get('categoryId');
      return json(products.filter((product) => !categoryId || product.category.id === categoryId));
    }
    if (url.pathname === '/api/lists') {
      return json([
        {
          id: E2E_LIST_ID,
          name: 'E2E список',
          isActive: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          _count: { items: 5 },
        },
      ]);
    }
    if (url.pathname === `/api/lists/${E2E_LIST_ID}`) {
      if (mode(scenario.listItems) === 'error') return json({ error: 'error' }, 500);
      return json({
        id: E2E_LIST_ID,
        name: 'E2E список',
        items: mode(scenario.listItems) === 'empty' ? [] : listItems(),
      });
    }
    if (
      url.pathname === `/api/lists/${E2E_LIST_ID}/import-text` ||
      url.pathname === '/api/lists/import-text'
    ) {
      if (scenario.importText === 'error') return importError('import.importFailed', 500);
      if (scenario.importText === 'rate') {
        return importError('rateLimited', 429);
      }
      if (scenario.importText === 'large') {
        return importError('import.payloadTooLarge', 413);
      }
      if (scenario.importText === 'result') return json(importResult(locale));
      return json({ message: '', results: { added: [], created: [], skipped: [], failed: [] } });
    }
    if (url.pathname === '/api/products/smart-create' && scenario.smartCreate === 'html') {
      return route.fulfill({
        status: 500,
        contentType: 'text/html',
        body: '<html><body>Bad gateway</body></html>',
      });
    }
    if (url.pathname === '/api/favorites') {
      if (mode(scenario.favorites) === 'error') return json({ error: 'error' }, 500);
      return json(mode(scenario.favorites) === 'empty' ? [] : favoritesFixture());
    }
    if (url.pathname === '/api/history') {
      if (mode(scenario.history) === 'error') return json({ error: 'error' }, 500);
      return json(mode(scenario.history) === 'empty' ? [] : historyFixture());
    }
    if (url.pathname === '/api/search') {
      if (mode(scenario.search) === 'error') return json({ error: 'error' }, 500);
      return json(mode(scenario.search) === 'empty' ? [] : products);
    }
    return json([]);
  });
}

// Error screens wait out the query client retries before the snapshot, so the final state is seen.
async function capture(page: Page, screen: string, locale: Locale, problems: string[]) {
  // Some screens keep a connection open, so network idle is a bounded wait, not a requirement.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(screen.includes('error') ? 12_000 : 400);
  const snapshot = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    text: document.body.innerText,
    dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map(
      (node) => (node as HTMLElement).innerText
    ),
  }));
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, `${screen}.${locale}.png`), fullPage: true });
  writeFileSync(
    path.join(outDir, `${screen}.${locale}.json`),
    JSON.stringify({ screen, locale, url: page.url(), problems, ...snapshot }, null, 2)
  );
}

type Screen = {
  id: string;
  path: string;
  scenario: Scenario;
  steps?: (page: Page, locale: Locale) => Promise<void>;
};

const typeSearch = (page: Page, locale: Locale, text: string) =>
  page
    .getByPlaceholder(lookup(messages(locale, 'catalog'), 'search.placeholder'), { exact: true })
    .fill(text, { timeout: 10_000 });

const openGrid = (page: Page, locale: Locale) =>
  page
    .getByRole('button', {
      name: lookup(messages(locale, 'lists'), 'listPage.gridView'),
      exact: true,
    })
    .click({ timeout: 10_000 });

// The button carries an emoji before its label, so the label is matched as a substring.
const openImport = (page: Page, locale: Locale) =>
  page
    .getByRole('button', { name: lookup(messages(locale, 'lists'), 'listPage.importFromText') })
    .click({ timeout: 10_000 });

const submitImport = async (page: Page, locale: Locale) => {
  await page.locator('#listText').fill('Молоко 2 шт\nХлеб бородинский\nСыр');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: lookup(messages(locale, 'lists'), 'importModal.import') })
    .click({ timeout: 10_000 });
};

const screens: Screen[] = [
  { id: 'home-anon', path: '/', scenario: { auth: false } },
  { id: 'login', path: '/login', scenario: { auth: false } },
  { id: 'register', path: '/register', scenario: { auth: false } },
  { id: 'forgot-password', path: '/forgot-password', scenario: { auth: false } },
  { id: 'reset-password', path: '/reset-password', scenario: { auth: false } },
  { id: 'categories', path: '/categories', scenario: { auth: true } },
  { id: 'categories-error', path: '/categories', scenario: { auth: true, categories: 'error' } },
  { id: 'catalog', path: `/categories/${e2eCategory.id}/products`, scenario: { auth: true } },
  {
    id: 'catalog-empty',
    path: '/categories/e2e-empty/products',
    scenario: { auth: true, products: 'empty' },
  },
  {
    id: 'catalog-error',
    path: `/categories/${e2eCategory.id}/products`,
    scenario: { auth: true, products: 'error' },
  },
  { id: 'list', path: `/lists/${E2E_LIST_ID}`, scenario: { auth: true } },
  {
    id: 'list-grid',
    path: `/lists/${E2E_LIST_ID}`,
    scenario: { auth: true },
    steps: (page, locale) => openGrid(page, locale),
  },
  { id: 'list-empty', path: `/lists/${E2E_LIST_ID}`, scenario: { auth: true, listItems: 'empty' } },
  { id: 'list-error', path: `/lists/${E2E_LIST_ID}`, scenario: { auth: true, listItems: 'error' } },
  {
    id: 'list-search-results',
    path: `/lists/${E2E_LIST_ID}`,
    scenario: { auth: true, search: 'ok' },
    steps: (page, locale) => typeSearch(page, locale, 'мол'),
  },
  {
    id: 'list-search-empty',
    path: `/lists/${E2E_LIST_ID}`,
    scenario: { auth: true, search: 'empty' },
    steps: (page, locale) => typeSearch(page, locale, 'zzz'),
  },
  {
    id: 'list-search-error',
    path: `/lists/${E2E_LIST_ID}`,
    scenario: { auth: true, search: 'error' },
    steps: (page, locale) => typeSearch(page, locale, 'мол'),
  },
  {
    id: 'import-modal',
    path: `/lists/${E2E_LIST_ID}`,
    scenario: { auth: true },
    steps: (page, locale) => openImport(page, locale),
  },
  {
    id: 'import-error',
    path: `/lists/${E2E_LIST_ID}`,
    scenario: { auth: true, importText: 'error' },
    steps: async (page, locale) => {
      await openImport(page, locale);
      await submitImport(page, locale);
    },
  },
  {
    id: 'import-result',
    path: `/lists/${E2E_LIST_ID}`,
    scenario: { auth: true, importText: 'result' },
    steps: async (page, locale) => {
      await openImport(page, locale);
      await submitImport(page, locale);
    },
  },
  {
    id: 'import-rate-limited',
    path: `/lists/${E2E_LIST_ID}`,
    scenario: { auth: true, importText: 'rate' },
    steps: async (page, locale) => {
      await openImport(page, locale);
      await submitImport(page, locale);
    },
  },
  {
    id: 'import-too-large',
    path: `/lists/${E2E_LIST_ID}`,
    scenario: { auth: true, importText: 'large' },
    steps: async (page, locale) => {
      await openImport(page, locale);
      await submitImport(page, locale);
    },
  },
  { id: 'favorites', path: '/categories/favorites', scenario: { auth: true } },
  {
    id: 'favorites-empty',
    path: '/categories/favorites',
    scenario: { auth: true, favorites: 'empty' },
  },
  {
    id: 'favorites-error',
    path: '/categories/favorites',
    scenario: { auth: true, favorites: 'error' },
  },
  { id: 'history', path: '/history', scenario: { auth: true } },
  { id: 'history-empty', path: '/history', scenario: { auth: true, history: 'empty' } },
  { id: 'history-error', path: '/history', scenario: { auth: true, history: 'error' } },
  {
    id: 'search-create-error',
    path: '/categories',
    scenario: { auth: true, search: 'empty', smartCreate: 'html' },
    steps: async (page, locale) => {
      await typeSearch(page, locale, 'Сметана');
      await page
        .getByRole('button', { name: lookup(messages(locale, 'catalog'), 'search.createWithAi') })
        .first()
        .click({ timeout: 10_000 });
    },
  },
  {
    id: 'categories-search',
    path: '/categories',
    scenario: { auth: true, search: 'ok' },
    steps: (page, locale) => typeSearch(page, locale, 'мол'),
  },
];

test.describe('AGE-1667 H1 phone sweep', () => {
  test.skip(!enabled, 'Screen sweep is opt-in: LOCALIZED_SWEEP=1 and SWEEP_DIR');
  test.setTimeout(180_000);
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  for (const locale of ['ru', 'en'] as const) {
    for (const screen of screens) {
      test(`${screen.id} ${locale}`, async ({ page, context }) => {
        const problems: string[] = [];
        page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
        await setup(page, context, locale, screen.scenario);
        await page.goto(screen.path);
        try {
          if (screen.steps) await screen.steps(page, locale);
        } catch (error) {
          problems.push(`step failed: ${(error as Error).message.split('\n')[0]}`);
        }
        await capture(page, screen.id, locale, problems);
      });
    }
  }
});
