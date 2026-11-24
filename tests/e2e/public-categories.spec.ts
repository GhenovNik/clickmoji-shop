import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type APIRequestContext } from '@playwright/test';
import sharp from 'sharp';
import { e2eCategory, mockPublicCatalog } from './fixtures/auth';

// Fetch the root document without following redirects and require HTTP 200 before reading HTML.
async function fetchRootWithoutRedirects(request: APIRequestContext, targetUrl = '/') {
  const response = await request.get(targetUrl, { maxRedirects: 0 });
  expect(response.status(), `${targetUrl} should return 200 without following redirects`).toBe(200);
  return response;
}

function listenLoopback(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        reject(new Error('Loopback server did not bind to an address'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test.describe('Public categories flows', () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicCatalog(page);
  });

  test('landing start CTA opens categories for anonymous users @smoke', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('main').getByRole('link', { name: 'Начать' }).click();

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
    const page = await fetchRootWithoutRedirects(request);
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

test.describe('Root redirect guard', () => {
  test('first GET / rejects 3xx redirects before reading HTML and never hits redirect target @smoke', async ({
    request,
  }) => {
    let originRequests = 0;
    let destinationRequests = 0;

    const destinationServer = createServer((_req, res) => {
      destinationRequests += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/apple-touch-icon.png"></head></html>'
      );
    });
    const destinationBaseUrl = await listenLoopback(destinationServer);

    const originServer = createServer((_req, res) => {
      originRequests += 1;
      res.writeHead(307, { location: `${destinationBaseUrl}/` });
      res.end();
    });
    const originBaseUrl = await listenLoopback(originServer);

    try {
      await expect(fetchRootWithoutRedirects(request, `${originBaseUrl}/`)).rejects.toThrow(/307/);
      expect(originRequests).toBe(1);
      expect(destinationRequests).toBe(0);
    } finally {
      await Promise.all([closeServer(originServer), closeServer(destinationServer)]);
    }
  });
});
