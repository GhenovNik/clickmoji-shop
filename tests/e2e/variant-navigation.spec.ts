import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  E2E_LIST_ID,
  e2eCategory,
  e2eMilkProduct,
  mockAuthenticatedShopping,
} from './fixtures/auth';

test('mobile variant selection adds to the list without visiting history @smoke', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const proxyRequests: string[] = [];
  const proxy = createServer((request, response) => {
    proxyRequests.push(request.url ?? '');
    response.writeHead(403).end();
  });
  proxy.on('connect', (request, socket) => {
    proxyRequests.push(request.url ?? '');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as AddressInfo).port;
  const context = await browser.newContext({
    baseURL: 'http://localhost:3000',
    locale: 'ru-RU',
    hasTouch: true,
    viewport: { width: 375, height: 812 },
    serviceWorkers: 'block',
    proxy: { server: `http://127.0.0.1:${port}`, bypass: 'localhost,127.0.0.1' },
  });
  try {
    const page = await context.newPage();
    const visits: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visits.push(new URL(frame.url()).pathname);
    });
    const blocked: string[] = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.fallback();
      blocked.push(url.href);
      return route.abort();
    });
    // A redirected navigation bypasses Playwright's route handler; the local proxy must deny it.
    await page.route('**/redirect-probe', (route) =>
      route.fulfill({ status: 302, headers: { location: 'http://outside.invalid/redirect-probe' } })
    );
    await page.goto('/redirect-probe').catch(() => null);
    expect(proxyRequests).toContain('http://outside.invalid/redirect-probe');
    const popup = await context.newPage();
    await popup.goto('http://outside.invalid/popup').catch(() => null);
    expect(blocked).toContain('http://outside.invalid/popup');
    expect(proxyRequests).not.toContain('http://outside.invalid/popup');
    await popup.close();
    expect(context.serviceWorkers()).toHaveLength(0);
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
    const payloads: unknown[] = [];
    await page.route('**/api/products?**', (route) => route.fulfill({ json: [apple] }));
    await page.route(`**/api/lists/${E2E_LIST_ID}**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/api/lists/${E2E_LIST_ID}/items` && route.request().method() === 'POST') {
        payloads.push(route.request().postDataJSON());
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
    expect(payloads).toEqual([{ items: [{ productId: apple.id, variantId: variant.id }] }]);
    expect(visits).not.toContain('/history');
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
