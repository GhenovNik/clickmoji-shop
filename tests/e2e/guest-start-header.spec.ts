import { test, expect, type Page } from '@playwright/test';
import { mockPublicCatalog } from './fixtures/auth';

const GUEST_SESSION = {
  user: { id: 'e2e-guest', role: 'USER', isGuest: true },
  expires: '2099-01-01T00:00:00.000Z',
};

/**
 * The guest Start flow, with the API mocked and the real next-auth client: the session endpoint
 * stays anonymous until the guest POST succeeds, exactly like the server would.
 */
async function mockGuestStart(page: Page) {
  let guestStarted = false;
  await mockPublicCatalog(page);
  // Registered after the catalog mock, so it runs first; catalog endpoints fall through to it.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/auth/csrf') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"csrfToken":"e2e"}',
      });
      return;
    }
    if (pathname === '/api/auth/session') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(guestStarted ? GUEST_SESSION : {}),
      });
      return;
    }
    if (pathname === '/api/auth/guest' && request.method() === 'POST') {
      guestStarted = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'e2e-guest', role: 'USER', isGuest: true } }),
      });
      return;
    }
    if (pathname === '/api/categories' || pathname === '/api/products') {
      await route.fallback();
      return;
    }
    // Lists, favorites and history start empty for a new guest (list endpoints return arrays).
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });
}

test.describe('guest Start on a phone-width screen', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Start replaces the anonymous header with the guest header without a reload @smoke', async ({
    page,
  }) => {
    await mockGuestStart(page);
    let documentLoads = 0;
    page.on('load', () => {
      documentLoads += 1;
    });

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Регистрация' })).toBeVisible();

    await page.getByRole('main').getByRole('button', { name: 'Начать' }).click();

    await expect(page).toHaveURL(/\/categories$/);
    await expect(page.getByRole('banner').getByText('Гость', { exact: true })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Регистрация' })).toHaveCount(
      0
    );
    expect(documentLoads).toBe(1);
    // The header keeps its controls inside the 16 px gutter once the guest badge replaces Register.
    const banner = await page.getByRole('banner').boundingBox();
    const badge = await page.getByRole('banner').getByText('Гость', { exact: true }).boundingBox();
    expect(banner && badge).toBeTruthy();
    expect(badge!.x + badge!.width).toBeLessThanOrEqual(390 - 16);
  });

  test('the anonymous header fits 390 px with its Register action fully visible', async ({
    page,
  }) => {
    await mockGuestStart(page);
    await page.goto('/');

    const register = page.getByRole('banner').getByRole('link', { name: 'Регистрация' });
    await expect(register).toBeVisible();
    const box = await register.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 - 16);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
  });
});
