import { test, expect } from '@playwright/test';

test.describe.skip('Public categories flows (requires auth + seed)', () => {
  test('categories page shows category links', async ({ page }) => {
    await page.goto('/categories');

    const categoryLinks = page.locator('a[href^="/categories/"][href$="/products"]');
    await expect(categoryLinks.first()).toBeVisible();
  });

  test('category products page shows product cards', async ({ page }) => {
    await page.goto('/categories');

    const categoryLinks = page.locator('a[href^="/categories/"][href$="/products"]');
    await categoryLinks.first().click();

    await expect(page).toHaveURL(/\/categories\/.+\/products/);

    const productName = page.locator('button p').first();
    await expect(productName).toBeVisible();
  });
});
