import { test, expect } from '@playwright/test';
import { mockPublicCatalog } from './fixtures/auth';

test.describe('Interface language', () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicCatalog(page);
  });

  test('an English browser gets the English UI on the first response @smoke', async ({
    browser,
  }) => {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await mockPublicCatalog(page);

    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('link', { name: /Open catalog/ })).toBeVisible();
    await context.close();
  });

  test('the switcher changes the language in place and remembers it @smoke', async ({ page }) => {
    await page.goto('/categories');
    await expect(page.getByRole('heading', { name: /Выберите категорию/ })).toBeVisible();

    await page
      .getByRole('group', { name: /Сменить язык/ })
      .getByRole('button', { name: 'en' })
      .click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveURL(/\/categories$/);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
