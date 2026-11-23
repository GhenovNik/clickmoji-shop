import { expect, test } from '@playwright/test';
import {
  E2E_LIST_ID,
  e2eCategory,
  e2eMilkProduct,
  mockAuthenticatedShopping,
} from './fixtures/auth';

test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });

test('mobile variant selection adds to the list without visiting history @smoke', async ({
  page,
}) => {
  test.setTimeout(60_000);

  const visits: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visits.push(new URL(frame.url()).pathname);
  });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      ? route.fallback()
      : route.abort();
  });
  await mockAuthenticatedShopping(page);
  const variant = {
    id: 'e2e-honeycrisp',
    name: 'Яблоко Ханикрисп',
    nameEn: 'Honeycrisp',
    emoji: '🍎',
  };
  const apple = {
    ...e2eMilkProduct,
    id: 'e2e-apple',
    name: 'Яблоко',
    nameEn: 'Apple',
    emoji: '🍎',
    variants: [variant],
  };
  let added = false;
  let payload: unknown;
  await page.route('**/api/products?**', (route) => route.fulfill({ json: [apple] }));
  await page.route(`**/api/lists/${E2E_LIST_ID}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/lists/${E2E_LIST_ID}/items` && route.request().method() === 'POST') {
      payload = route.request().postDataJSON();
      added = true;
      await route.fulfill({
        json: {
          createdItems: [{ id: 'apple-item', productId: apple.id }],
          message: 'Добавлено 1 товаров.',
        },
      });
    } else if (path === `/api/lists/${E2E_LIST_ID}`) {
      await route.fulfill({
        json: {
          id: E2E_LIST_ID,
          name: 'E2E список',
          items: added
            ? [{ id: 'apple-item', isPurchased: false, note: null, product: apple, variant }]
            : [],
        },
      });
    } else {
      await route.fallback();
    }
  });
  await page.goto(`/categories?listId=${E2E_LIST_ID}`);
  await page.getByTestId('category-link').filter({ hasText: e2eCategory.name }).tap();
  const card = page.getByTestId('product-card').filter({ hasText: 'Яблоко' });
  await card
    .locator('..')
    .getByRole('button', { name: /Варианты/ })
    .tap();
  await page.getByTestId('variant-card').filter({ hasText: variant.name }).tap();
  await page.getByRole('button', { name: 'Добавить', exact: true }).tap();
  await expect(page).toHaveURL(new RegExp(`/lists/${E2E_LIST_ID}$`));
  await expect(page.locator('main').getByText(variant.name, { exact: true })).toBeVisible();
  expect(payload).toEqual({ items: [{ productId: apple.id, variantId: variant.id }] });
  expect(visits).not.toContain('/history');
});
