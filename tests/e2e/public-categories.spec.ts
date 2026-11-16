import { test, expect } from '@playwright/test';
import sharp from 'sharp';
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

  test('fresh-install icon chain resolves for anonymous users @smoke', async ({ request }) => {
    const page = await request.get('/');
    expect(page.status()).toBe(200);
    const html = await page.text();

    const linkHref = (rel: string) => {
      const match = html.match(new RegExp(`<link[^>]+rel="${rel}"[^>]+href="([^"]+)"`));
      return match?.[1];
    };

    const manifestHref = linkHref('manifest');
    const appleHref = linkHref('apple-touch-icon');

    // Validate extracted links before any fetch so this test can never leave the isolated origin.
    expect(manifestHref, 'built HTML links a same-origin manifest').toBe('/manifest.json');
    expect(appleHref, 'built HTML links a same-origin apple-touch-icon').toBe(
      '/apple-touch-icon.png'
    );

    const manifestResponse = await request.get(manifestHref as string, { maxRedirects: 0 });
    expect(manifestResponse.status()).toBe(200);
    expect(manifestResponse.headers()['content-type']).toMatch(
      /application\/manifest\+json|application\/json/
    );
    const manifest = (await manifestResponse.json()) as {
      icons: Array<{ src: string; type?: string; sizes?: string }>;
    };
    const pngIcons = manifest.icons.filter((icon) => icon.type === 'image/png');
    expect(pngIcons.map((icon) => icon.src).sort()).toEqual([
      '/icons/icon-192.png',
      '/icons/icon-512.png',
    ]);

    const expectedPng = /^\/icons\/icon-(192|512)\.png$/;
    const targets = [...pngIcons.map((icon) => icon.src), appleHref as string];
    for (const target of targets) {
      const allowed = expectedPng.test(target) || target === '/apple-touch-icon.png';
      expect(allowed, `${target} is not a known same-origin icon path`).toBe(true);
      const response = await request.get(target, { maxRedirects: 0 });
      expect(response.status(), `${target} should not redirect to sign-in`).toBe(200);
      expect(response.headers()['content-type']).toMatch(/image\/png/);
      const body = await response.body();
      const decoded = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(decoded.info.channels, `${target} decodes to 4 channels`).toBe(4);
    }

    for (const nearMatch of [
      '/icons/icon-192.png/extra',
      '/icons/icon-512.pngx',
      '/apple-touch-icon.png/extra',
    ]) {
      const response = await request.get(nearMatch, { maxRedirects: 0 });
      expect(response.status(), `${nearMatch} must keep the auth redirect`).toBe(307);
      expect(response.headers()['location']).toContain('/login');
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
