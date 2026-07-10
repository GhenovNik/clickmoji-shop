import { expect, test } from '@playwright/test';

test.describe('Client state ownership', () => {
  test('adds a category product through React Query list state', async ({ page }) => {
    const listId = 'list-react-query';
    let listsRequests = 0;
    let addRequestBody: unknown = null;

    await page.route('**/api/auth/session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'user-1',
            name: 'QA User',
            email: 'qa@example.com',
            role: 'USER',
          },
          expires: '2099-01-01T00:00:00.000Z',
        }),
      });
    });

    await page.route('**/api/lists', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }

      listsRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: listId,
            name: 'На неделю',
            isActive: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            _count: { items: listsRequests > 1 ? 1 : 0 },
          },
        ]),
      });
    });

    await page.route('**/api/products?categoryId=cat-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'product-1',
            name: 'Молоко',
            nameEn: 'Milk',
            emoji: '🥛',
            isCustom: false,
            imageUrl: null,
            variants: [],
            category: {
              id: 'cat-1',
              name: 'Молочные продукты',
              emoji: '🥛',
              isCustom: false,
              imageUrl: null,
            },
          },
        ]),
      });
    });

    await page.route('**/api/favorites', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route(`**/api/lists/${listId}/items`, async (route) => {
      addRequestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          createdItems: [{ id: 'item-1', productId: 'product-1' }],
          message: 'Добавлено 1 товаров.',
        }),
      });
    });

    await page.goto(`/categories/cat-1/products?listId=${listId}`);

    await expect(page.getByTestId('products-grid').first()).toBeVisible();
    await page.getByTestId('product-card').first().click();
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();

    await expect
      .poll(() => addRequestBody)
      .toEqual({
        items: [{ productId: 'product-1', variantId: null }],
      });
    await expect.poll(() => listsRequests).toBeGreaterThan(1);
  });
});
