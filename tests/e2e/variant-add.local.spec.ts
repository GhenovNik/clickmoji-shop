import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { createPrismaPgAdapter } from '../../src/lib/prisma-adapter';

// Run via npm run test:e2e:variants, never against the ordinary mocked suite or prod.
test.skip(process.env.PLAYWRIGHT_LOCAL_DB !== '1', 'Requires guarded local variant config');
let db: PrismaClient;
let userId: string;
let email: string;
let categoryId: string;
let productId: string;
let variantId: string;
const password = 'local-fixture-only-AGE-1536';

test.beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || (target.port || '5432') !== '5432') {
    throw new Error('Refusing non-local variant E2E fixtures');
  }
  db = new PrismaClient({ adapter: createPrismaPgAdapter() });
  email = `variant-e2e-${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: { email, password: await bcrypt.hash(password, 4), emailVerified: new Date() },
  });
  userId = user.id;
  const apple = await db.product.findFirstOrThrow({
    where: { name: 'Яблоко', isGlobal: true },
    include: { variants: { where: { name: 'Яблоко Ханикрисп' } } },
  });
  expect(apple.variants).toHaveLength(1);
  categoryId = apple.categoryId;
  productId = apple.id;
  variantId = apple.variants[0].id;
});
test.afterAll(async () => {
  if (!db) return;
  try {
    if (userId) {
      await db.user.deleteMany({ where: { id: userId } });
      expect(await db.user.count({ where: { id: userId } })).toBe(0);
    }
  } finally {
    await db.$disconnect();
  }
});

test.beforeEach(async ({ context }) => {
  const csrf = await (await context.request.get('/api/auth/csrf')).json();
  const login = await context.request.post('/api/auth/callback/credentials', {
    form: { csrfToken: csrf.csrfToken, email, password, json: 'true' },
  });
  expect(login.ok()).toBe(true);
  const session = await (await context.request.get('/api/auth/session')).json();
  expect(session.user.id).toBe(userId);
  await db.list.updateMany({ where: { userId, isActive: true }, data: { isActive: false } });
});

async function chooseHoneycrisp(page: Page, listId: string) {
  await page.goto(`/categories?listId=${listId}`);
  await page
    .locator(
      `a[data-testid="category-link"][href="/categories/${categoryId}/products?listId=${listId}"]`
    )
    .tap();
  const card = page
    .getByTestId('product-card')
    .filter({ has: page.getByText('Яблоко', { exact: true }) });
  await card
    .locator('..')
    .getByRole('button', { name: /Варианты/ })
    .tap();
  await page.getByTestId('variant-card').filter({ hasText: 'Яблоко Ханикрисп' }).tap();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
const addButton = (page: Page) => page.getByRole('button', { name: 'Добавить', exact: true });

test('AI partial success retries only list add, not successful catalog creation', async ({
  page,
}, testInfo) => {
  const list = await db.list.create({
    data: { userId, name: 'AI partial retry E2E', isActive: true },
  });
  let creates = 0;
  let adds = 0;
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.route('**/api/search?**', (route) => route.fulfill({ json: [] }));
  // Explicitly simulate the AI response; no paid/external provider is called.
  await page.route('**/api/products/smart-create', async (route) => {
    creates++;
    await route.fulfill({
      json: {
        product: { id: productId, name: 'Яблоко', nameEn: 'Apple', emoji: '🍎' },
        exists: false,
      },
    });
  });
  await page.route(`**/api/lists/${list.id}/items`, async (route) => {
    adds++;
    if (adds === 1)
      return route.fulfill({
        status: 500,
        json: { error: 'Injected list-add failure after catalog success' },
      });
    return route.continue();
  });
  await page.goto(`/categories?listId=${list.id}`);
  await page.getByPlaceholder('Поиск товаров...').fill('AI partial fixture');
  await page.getByRole('button', { name: /Создать через AI/ }).tap();
  await expect(page.locator('main').getByRole('alert')).toContainText('Товар создан в каталоге');
  expect(creates).toBe(1);
  expect(adds).toBe(1);
  expect(await db.item.count({ where: { listId: list.id } })).toBe(0);
  await page.getByRole('button', { name: 'Повторить добавление в список', exact: true }).tap();
  await expect(page).toHaveURL(`http://localhost:3136/lists/${list.id}`);
  expect(creates).toBe(1);
  expect(adds).toBe(2);
  expect(await db.item.count({ where: { listId: list.id, productId } })).toBe(1);
  expect(dialogs).toEqual([]);
  await testInfo.attach('partial-retry-receipt.json', {
    body: JSON.stringify({ creates, adds, dialogs }),
    contentType: 'application/json',
  });
});

test('adds the same Honeycrisp twice through real API and renders two pending variant badges', async ({
  page,
}, testInfo) => {
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const list = await db.list.create({
    data: { userId, name: 'Variant duplicate E2E', isActive: true },
  });
  for (const count of [1, 2]) {
    await chooseHoneycrisp(page, list.id);
    await addButton(page).tap();
    await expect(page).toHaveURL(`http://localhost:3136/lists/${list.id}`);
    await expect(page.locator('main span').filter({ hasText: /^Яблоко Ханикрисп$/ })).toHaveCount(
      count
    );
  }
  expect(
    await db.item.count({ where: { listId: list.id, productId, variantId, isPurchased: false } })
  ).toBe(2);
  expect(dialogs).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('duplicate-variant-list.png') });
});

for (const failure of ['500', '403', 'network'] as const) {
  test(`add failure ${failure} is inline, creates no native OK dialog and stays out of History`, async ({
    page,
  }, testInfo) => {
    const dialogs: string[] = [];
    const navigation: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigation.push(frame.url());
    });
    const list = await db.list.create({
      data: { userId, name: `Variant failure ${failure}`, isActive: true },
    });
    await chooseHoneycrisp(page, list.id);
    const path = `/categories/${categoryId}/products?listId=${list.id}`;
    let attempts = 0;
    await page.route(`**/api/lists/${list.id}/items`, async (route) => {
      attempts++;
      if (attempts > 1) return route.continue();
      if (failure === 'network') return route.abort('failed');
      return route.fulfill({ status: Number(failure), json: { error: 'Injected add failure' } });
    });
    await addButton(page).tap();
    await expect(page.locator('main').getByRole('alert')).toHaveText(
      'Ошибка при добавлении товаров'
    );
    await expect(page.locator('main').getByRole('alert')).toBeVisible();
    expect(dialogs).toEqual([]); // RED on master: native alert, no inline feedback.
    await expect(page).toHaveURL(`http://localhost:3136${path}`);
    await expect(addButton(page)).toBeEnabled();
    expect(await db.item.count({ where: { listId: list.id } })).toBe(0);

    // Representative phone alert-OK area, not an intentional tap on History.
    // Playwright cannot observe OS-native alert geometry; absence of ANY native
    // dialog is the invariant removing the modal-dismissal/click-through path.
    const okArea = { x: 300, y: 450 };
    expect(
      await page.evaluate(
        ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('a[href="/history"]')),
        okArea
      )
    ).toBe(false);
    await page.touchscreen.tap(okArea.x, okArea.y);
    await expect(page).toHaveURL(`http://localhost:3136${path}`);
    expect(navigation.some((url) => new URL(url).pathname === '/history')).toBe(false);
    await expect(page.getByRole('button', { name: 'Яблоко Ханикрисп', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('inline-error-after-ok-area-tap.png') });
    await testInfo.attach('navigation.json', {
      body: JSON.stringify({ failure, dialogs, navigation, okArea }),
      contentType: 'application/json',
    });

    // Retry uses the preserved selection and real local API, not a mocked success.
    await addButton(page).tap();
    await expect(page).toHaveURL(`http://localhost:3136/lists/${list.id}`);
    await expect(page.locator('main span').filter({ hasText: /^Яблоко Ханикрисп$/ })).toBeVisible();
    expect(await db.item.count({ where: { listId: list.id, variantId } })).toBe(1);
    expect(dialogs).toEqual([]);
  });
}
