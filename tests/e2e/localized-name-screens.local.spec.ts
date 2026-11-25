import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import {
  E2E_LIST_ID,
  createShoppingItem,
  e2eCategory,
  e2eMilkProduct,
  mockAuthenticatedShopping,
  type E2EShoppingItem,
} from './fixtures/auth';

// AGE-1667: four phone-width screens (catalog and shopping list, Russian and English) with local
// fixture data only. Opt-in so the ordinary suite never writes them:
//   LOCALIZED_NAME_SCREENS=1 npx playwright test tests/e2e/localized-name-screens.local.spec.ts \
//     --project=chromium --reporter=line
// Output: $LOCALIZED_NAME_SCREENS_DIR, default test-results/localized-name-screens (git-ignored).

const outDir =
  process.env.LOCALIZED_NAME_SCREENS_DIR ?? path.join('test-results', 'localized-name-screens');

// The category as the API returns it: both names. The shared fixture has no English name, which
// would show the Russian heading in English.
const dairy = { ...e2eCategory, nameEn: 'Dairy' };

// Every name has its English translation except one deliberate legacy fallback: 'Хлеб бородинский'
// has no English name, so it stays Russian in English (the only allowed Russian name there).
const products = [
  {
    ...e2eMilkProduct,
    id: 'e2e-milk',
    name: 'Молоко',
    nameEn: 'Milk',
    category: dairy,
    variants: [],
  },
  {
    ...e2eMilkProduct,
    id: 'e2e-bread',
    name: 'Хлеб бородинский',
    nameEn: '',
    emoji: '🍞',
    category: dairy,
    variants: [],
  },
  {
    ...e2eMilkProduct,
    id: 'e2e-ketchup',
    name: 'Кетчуп',
    nameEn: 'Ketchup',
    emoji: '🥫',
    category: dairy,
    variants: [],
  },
  {
    ...e2eMilkProduct,
    id: 'e2e-cheese',
    name: 'Сыр',
    nameEn: 'Cheese',
    emoji: '🧀',
    category: dairy,
    variants: [],
  },
];

// The shopping list shows the same products. The fixture's list item has no English names, so the
// English names of the product and its category are added here.
function listItems(): E2EShoppingItem[] {
  return products.map((product, index) => {
    const base = createShoppingItem(`e2e-item-${index}`, product);
    return {
      ...base,
      product: {
        ...base.product,
        nameEn: product.nameEn,
        category: { ...base.product.category, nameEn: product.category.nameEn },
      },
    } as E2EShoppingItem;
  });
}

async function setLocale(context: BrowserContext, locale: 'ru' | 'en') {
  await context.addCookies([
    { name: 'NEXT_LOCALE', value: locale, domain: 'localhost', path: '/', sameSite: 'Lax' },
  ]);
}

async function mockCatalog(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname === '/api/auth/session') return json({});
    if (url.pathname === '/api/categories') return json([dairy]);
    if (url.pathname === '/api/products') {
      const categoryId = url.searchParams.get('categoryId');
      return json(products.filter((product) => !categoryId || product.category.id === categoryId));
    }
    return json([]);
  });
}

async function screenshot(page: Page, file: string) {
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, file), fullPage: true });
}

test.describe('catalogue names by interface language', () => {
  test.skip(process.env.LOCALIZED_NAME_SCREENS !== '1', 'Screenshot capture is opt-in');
  test.setTimeout(120_000);
  // A phone viewport, same as the Pixel 5 project but at a fixed 390 px width.
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  test('catalog in Russian: category one Russian name, products keep the English hint', async ({
    page,
    context,
  }) => {
    await setLocale(context, 'ru');
    await mockCatalog(page);
    await page.goto(`/categories/${e2eCategory.id}/products`);

    await expect(page.getByText('Milk', { exact: true })).toBeVisible();
    await expect(page.getByText('Молоко', { exact: true })).toBeVisible();
    // Category heading: one Russian name, a single line, no English line and no subtitle.
    const heading = page.getByRole('heading', { level: 1, name: 'Молочные продукты' });
    await expect(heading).toBeVisible();
    await expect(page.getByText('Dairy', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Выберите товары одним нажатием')).toHaveCount(0);
    const headingBox = await heading.boundingBox();
    expect(headingBox?.height ?? Infinity).toBeLessThanOrEqual(40);
    await expect(page.getByText('Ketchup', { exact: true })).toBeVisible();
    await screenshot(page, 'catalog-ru.png');
  });

  test('catalog in English: no Russian name where English is filled', async ({ page, context }) => {
    await setLocale(context, 'en');
    await mockCatalog(page);
    await page.goto(`/categories/${e2eCategory.id}/products`);

    await expect(page.getByText('Milk', { exact: true })).toBeVisible();
    await expect(page.getByText('Молоко', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Кетчуп', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Молочные продукты', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Dairy', { exact: true })).toBeVisible();
    await expect(page.getByText('Ketchup', { exact: true })).toBeVisible();
    // Explicit exception: no English name for bread, so the Russian one is the only name.
    await expect(page.getByText('Хлеб бородинский', { exact: true })).toBeVisible();
    await screenshot(page, 'catalog-en.png');
  });

  test('shopping list in Russian: category group one Russian name, product hints kept', async ({
    page,
    context,
  }) => {
    await setLocale(context, 'ru');
    await mockAuthenticatedShopping(page, listItems());
    await page.goto(`/lists/${E2E_LIST_ID}`);

    await expect(page.getByTestId('shopping-item')).toHaveCount(products.length);
    await expect(page.getByText('Milk', { exact: true })).toBeVisible();
    // Group heading (the category, with its count): the Russian name only.
    await expect(page.locator('h3', { hasText: 'Молочные продукты' })).toBeVisible();
    await expect(page.locator('h3', { hasText: 'Dairy' })).toHaveCount(0);
    await screenshot(page, 'list-ru.png');
  });

  test('shopping list in English: no Russian name where English is filled', async ({
    page,
    context,
  }) => {
    await setLocale(context, 'en');
    await mockAuthenticatedShopping(page, listItems());
    await page.goto(`/lists/${E2E_LIST_ID}`);

    await expect(page.getByTestId('shopping-item')).toHaveCount(products.length);
    await expect(page.getByText('Milk', { exact: true })).toBeVisible();
    await expect(page.getByText('Молоко', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Сыр', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Кетчуп', { exact: true })).toHaveCount(0);
    await expect(page.locator('h3', { hasText: 'Молочные продукты' })).toHaveCount(0);
    await expect(page.locator('h3', { hasText: 'Dairy' })).toBeVisible();
    await expect(page.getByText('Ketchup', { exact: true })).toBeVisible();
    // Explicit exception: bread has no English name and stays Russian.
    await expect(page.getByText('Хлеб бородинский', { exact: true })).toBeVisible();
    await screenshot(page, 'list-en.png');
  });
});
