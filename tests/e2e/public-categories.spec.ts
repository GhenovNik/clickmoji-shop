import { test, expect } from '@playwright/test';
import { e2eCategory, mockPublicCatalog } from './fixtures/auth';

test.describe('Public categories flows', () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicCatalog(page);
  });

  test('landing catalog CTA opens categories for anonymous users @smoke', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('link', { name: /Открыть каталог/ }).click();

    await expect(page).toHaveURL(/\/categories$/);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: /Выберите категорию/ })).toBeVisible();
    await expect(page.getByTestId('categories-grid')).toBeVisible();
  });

  test('public application assets stay accessible without a session @smoke', async ({
    request,
  }) => {
    const expectedAssets = [
      ['/manifest.json', /application\/manifest\+json|application\/json/],
      ['/sw.js', /javascript/],
      ['/offline.html', /text\/html/],
      ['/robots.txt', /text\/plain/],
      ['/sitemap.xml', /application\/xml|text\/xml/],
    ] as const;

    for (const [path, contentType] of expectedAssets) {
      const response = await request.get(path, { maxRedirects: 0 });

      expect(response.status(), `${path} should not redirect to sign-in`).toBe(200);
      expect(response.headers()['content-type']).toMatch(contentType);
    }
  });

  test('public pages include baseline security headers @smoke', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();

    expect(response.status()).toBe(200);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
  });

  test('categories page is accessible to anonymous users @smoke', async ({ page }) => {
    await page.goto('/categories');

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId('categories-grid')).toBeVisible();
  });

  test('category products route is accessible to anonymous users @smoke', async ({ page }) => {
    await page.goto(`/categories/${e2eCategory.id}/products`);

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`/categories/${e2eCategory.id}/products$`));
    await expect(page.getByRole('main').getByTestId('products-grid')).toBeVisible();
  });

  test('category products show login CTA for add-to-list actions @smoke', async ({ page }) => {
    await page.goto(`/categories/${e2eCategory.id}/products`);

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`/categories/${e2eCategory.id}/products$`));
    await expect(page.getByRole('main').getByTestId('products-grid')).toBeVisible();

    const productCard = page.getByTestId('product-card').first();
    await expect(productCard).toBeVisible();
    await productCard.click();

    await expect(page.getByRole('link', { name: /Войти и добавить/ })).toBeVisible();
  });
});
