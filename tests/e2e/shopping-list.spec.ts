import { expect, test } from '@playwright/test';
import {
  E2E_LIST_ID,
  createShoppingItem,
  e2eCategory,
  e2eMilkProduct,
  mockAuthenticatedShopping,
} from './fixtures/auth';

test.describe('Shopping list smoke flows', () => {
  test('adds product via search with authenticated fixture @smoke', async ({ page }) => {
    const state = await mockAuthenticatedShopping(page, [createShoppingItem('seed-item')]);

    await page.goto(`/lists/${E2E_LIST_ID}`);

    await expect(page.getByRole('heading', { name: /E2E список/ })).toBeVisible();
    await page.getByPlaceholder('Поиск товаров...').fill('молоко');

    const result = page.getByRole('button', { name: /Молоко/ }).first();
    await expect(result).toBeVisible();
    const dialogPromise = page.waitForEvent('dialog');
    await Promise.all([
      result.click(),
      dialogPromise.then(async (dialog) => {
        expect(dialog.message()).toContain('Молоко');
        expect(dialog.message()).toContain('добавлен');
        await dialog.accept();
      }),
    ]);

    await expect
      .poll(() => state.addItemRequests)
      .toEqual([{ items: [{ productId: e2eMilkProduct.id, variantId: null }] }]);
    await expect.poll(() => state.items).toHaveLength(2);
  });

  test('adds product from category grid with authenticated fixture @smoke', async ({ page }) => {
    const state = await mockAuthenticatedShopping(page);

    await page.goto(`/categories/${e2eCategory.id}/products?listId=${E2E_LIST_ID}`);

    const main = page.getByRole('main');
    await expect(main.getByTestId('products-grid')).toBeVisible();
    await main.getByTestId('product-card').first().click();
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();

    await expect
      .poll(() => state.addItemRequests)
      .toEqual([{ items: [{ productId: e2eMilkProduct.id, variantId: null }] }]);
    await expect.poll(() => state.items).toHaveLength(1);
    await expect(page).toHaveURL(new RegExp(`/lists/${E2E_LIST_ID}$`));
    await expect(page.getByText('Молоко')).toBeVisible();
  });
});
