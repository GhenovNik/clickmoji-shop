import { test, expect } from '@playwright/test';

test.describe.skip('Shopping List - Product Addition (requires auth + seed)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should add product via search', async ({ page }) => {
    // Type in search box
    await page.fill('input[placeholder*="Поиск"]', 'молоко');

    // Wait for search results
    await page.waitForSelector('text=Молоко', { timeout: 5000 });

    // Click on product in search results
    await page.click('text=Молоко');

    // Verify success message appears
    await expect(page.locator('text=добавлен в список')).toBeVisible();
  });

  test('should add product via categories', async ({ page }) => {
    // Navigate to categories
    await page.goto('/categories');

    // Select a category (adjust selector based on your UI)
    try {
      await page.click('text=Молочные продукты >> visible=true');
    } catch {
      // Fallback if exact text not found
      await page.locator('.category-card').first().click();
    }

    // Select a product
    const firstProduct = page.locator('[data-testid="product-card"]').first();
    await firstProduct.click();

    // Click "Add to list" button
    await page.click('button:has-text("Добавить в список")');

    // Verify navigation to lists page
    await expect(page).toHaveURL(/\/lists/);
  });
});
