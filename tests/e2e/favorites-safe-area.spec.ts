import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  E2E_AUTH_BYPASS_TOKEN,
  E2E_AUTH_COOKIE,
  E2E_LIST_ID,
  e2eCategory,
  e2eMilkProduct,
  mockAuthenticatedShopping,
} from './fixtures/auth';

const FAVORITES_PATH = '/categories/favorites';
const IMPLEMENTATION_DIR = 'docs/kb/AGE-1486/implementation';

const favoriteMilkItem = {
  id: 'fav-e2e-milk',
  productId: e2eMilkProduct.id,
  product: e2eMilkProduct,
  variant: null,
};

type SafeAreaInsets = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

type BoxWithHit = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  x: number;
  y: number;
  hitsTarget: boolean;
  hitTag: string | null;
};

const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ baseURL, page }) => {
  expect(new URL(baseURL!).origin).toBe('http://localhost:3000');
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page), 'No unhandled browser errors').toEqual([]);
});

async function applySafeAreaInsets(page: Page, insets: SafeAreaInsets) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: {
      top: insets.top,
      topMax: insets.top,
      left: insets.left,
      leftMax: insets.left,
      right: insets.right,
      rightMax: insets.right,
      bottom: insets.bottom,
      bottomMax: insets.bottom,
    },
  });
}

async function measureEnvSafeAreaInsets(page: Page): Promise<SafeAreaInsets> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.paddingTop = 'env(safe-area-inset-top, 0px)';
    probe.style.paddingLeft = 'env(safe-area-inset-left, 0px)';
    probe.style.paddingRight = 'env(safe-area-inset-right, 0px)';
    probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const measured = {
      top: parseFloat(style.paddingTop),
      left: parseFloat(style.paddingLeft),
      right: parseFloat(style.paddingRight),
      bottom: parseFloat(style.paddingBottom),
    };
    probe.remove();
    return measured;
  });
}

async function measureHitBox(locator: Locator): Promise<BoxWithHit> {
  await expect(locator).toHaveCount(1);
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      x,
      y,
      hitsTarget: Boolean(hit && (hit === element || element.contains(hit))),
      hitTag: hit?.outerHTML.slice(0, 200) ?? null,
    };
  });
}

async function mockAuthenticatedFavorites(page: Page) {
  const state = await mockAuthenticatedShopping(page);
  await page.route('**/api/favorites', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([favoriteMilkItem]),
    });
  });
  return state;
}

async function saveImplementationScreenshot(
  page: Page,
  filename: string,
  testInfo: {
    outputPath: (name: string) => string;
    attach: (name: string, options: { path: string; contentType: string }) => Promise<void>;
  }
) {
  const implPath = `${IMPLEMENTATION_DIR}/${filename}`;
  mkdirSync(dirname(implPath), { recursive: true });
  await page.screenshot({ path: implPath, fullPage: false, animations: 'disabled' });
  const testOutput = testInfo.outputPath(filename);
  await page.screenshot({ path: testOutput, fullPage: false, animations: 'disabled' });
  await testInfo.attach(filename, { path: testOutput, contentType: 'image/png' });
}

test.describe('AGE-1486 AC-1 direct favorites navigation', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, serviceWorkers: 'block' });

  test('holds /categories/favorites across delayed session and enforces anonymous 307/401 @smoke', async ({
    baseURL,
    browser,
    page,
  }) => {
    const cleanContext = await browser.newContext({
      baseURL,
      viewport: { width: 375, height: 812 },
      serviceWorkers: 'block',
    });
    try {
      const anonymousDoc = await cleanContext.request.get(FAVORITES_PATH, { maxRedirects: 0 });
      expect(anonymousDoc.status()).toBe(307);
      const locationHeader = anonymousDoc.headers()['location'];
      expect(locationHeader).toBeTruthy();
      const parsedLocation = new URL(locationHeader, baseURL!);
      expect(parsedLocation.origin).toBe(new URL(baseURL!).origin);
      expect(parsedLocation.pathname).toBe('/login');

      const anonymousApi = await cleanContext.request.get('/api/favorites', { maxRedirects: 0 });
      expect(anonymousApi.status()).toBe(401);
      const apiBody = await anonymousApi.json();
      expect(Array.isArray(apiBody)).toBe(false);
      expect(apiBody).toEqual({ error: expect.any(String) });
    } finally {
      await cleanContext.close();
    }

    await page.context().addCookies([
      {
        name: E2E_AUTH_COOKIE,
        value: E2E_AUTH_BYPASS_TOKEN,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    const observedPathnames: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        observedPathnames.push(new URL(frame.url()).pathname);
      }
    });

    let resolveSessionRequest!: () => void;
    const sessionRequested = new Promise<void>((resolve) => {
      resolveSessionRequest = resolve;
    });
    let releaseSession!: () => void;
    const heldSession = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });

    await page.route('**/api/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/api/auth/session') {
        resolveSessionRequest();
        await heldSession;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: 'e2e-user',
              name: 'E2E User',
              email: 'e2e@example.com',
              role: 'USER',
            },
            expires: '2099-01-01T00:00:00.000Z',
          }),
        });
        return;
      }
      if (pathname === '/api/favorites') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([favoriteMilkItem]),
        });
        return;
      }
      if (pathname === '/api/lists') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: E2E_LIST_ID,
              name: 'E2E список',
              isActive: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              _count: { items: 0 },
            },
          ]),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    try {
      const response = await page.goto(FAVORITES_PATH, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      await Promise.race([
        sessionRequested,
        page.waitForTimeout(12_000).then(() => {
          throw new Error('Client /api/auth/session request was not observed after hydration');
        }),
      ]);
      // Give client effects a chance to fire while session is still loading.
      await page.waitForTimeout(300);
      expect(new URL(page.url()).pathname).toBe(FAVORITES_PATH);
      expect(observedPathnames.every((pathname) => pathname === FAVORITES_PATH)).toBe(true);
    } finally {
      releaseSession();
    }

    await expect(
      page.getByRole('heading', { level: 1, name: 'Избранное', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Молоко/ })).toBeVisible();
    expect(observedPathnames.length).toBeGreaterThanOrEqual(1);
    expect(observedPathnames.every((pathname) => pathname === FAVORITES_PATH)).toBe(true);
  });
});

test.describe('AGE-1486 AC-2 safe-area 375x812', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('renders 0px and 34px bottom safe-area insets without overlap and delivers coordinate taps @smoke', async ({
    page,
  }, testInfo) => {
    const state = await mockAuthenticatedFavorites(page);
    await page.goto(FAVORITES_PATH);

    const card = page.getByRole('button', { name: /Молоко/ });
    await expect(card).toBeVisible();
    await card.tap();

    const nav = page.getByRole('navigation');
    const navRow = nav.locator('> div').first();
    const favLink = nav.getByRole('link', { name: 'Избранное', exact: true });
    const addButton = page.getByRole('button', { name: 'Добавить', exact: true });
    const selectionBar = page.locator('div.fixed').filter({ has: addButton });

    await expect(nav).toBeVisible();
    await expect(selectionBar).toBeVisible();

    await applySafeAreaInsets(page, { top: 0, left: 0, right: 0, bottom: 0 });
    expect((await measureEnvSafeAreaInsets(page)).bottom).toBe(0);

    const zeroMetrics = await page.evaluate(() => {
      const navEl = document.querySelector('nav')!;
      const navRowEl = navEl.firstElementChild as HTMLElement;
      const addBtn = Array.from(document.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Добавить'
      )!;
      const barEl = addBtn.closest('div.fixed') as HTMLElement;
      const navStyle = getComputedStyle(navEl);
      const barStyle = getComputedStyle(barEl);
      return {
        navPaddingBottom: parseFloat(navStyle.paddingBottom),
        barPaddingBottom: parseFloat(barStyle.paddingBottom),
        navRect: navEl.getBoundingClientRect().toJSON(),
        navRowRect: navRowEl.getBoundingClientRect().toJSON(),
        barRect: barEl.getBoundingClientRect().toJSON(),
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });

    expect(zeroMetrics.navPaddingBottom).toBe(0);
    expect(zeroMetrics.barPaddingBottom).toBe(16);
    expect(zeroMetrics.hasHorizontalOverflow).toBe(false);
    expect(zeroMetrics.barRect.bottom).toBeLessThanOrEqual(zeroMetrics.navRowRect.top + 0.5);

    await page.evaluate(() => document.fonts.ready);
    await saveImplementationScreenshot(page, 'favorites-375-inset-0.png', testInfo);

    await applySafeAreaInsets(page, { top: 0, left: 0, right: 0, bottom: 34 });
    expect((await measureEnvSafeAreaInsets(page)).bottom).toBe(34);

    const insetMetrics = await page.evaluate(() => {
      const navEl = document.querySelector('nav')!;
      const navRowEl = navEl.firstElementChild as HTMLElement;
      const addBtn = Array.from(document.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Добавить'
      )!;
      const barEl = addBtn.closest('div.fixed') as HTMLElement;
      const navStyle = getComputedStyle(navEl);
      return {
        navPaddingBottom: parseFloat(navStyle.paddingBottom),
        navRect: navEl.getBoundingClientRect().toJSON(),
        navRowRect: navRowEl.getBoundingClientRect().toJSON(),
        barRect: barEl.getBoundingClientRect().toJSON(),
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });

    expect(insetMetrics.navPaddingBottom).toBe(34);
    expect(insetMetrics.navRect.bottom - insetMetrics.navRowRect.bottom).toBeGreaterThanOrEqual(
      33.5
    );
    expect(insetMetrics.navRowRect.bottom).toBeLessThanOrEqual(812 - 34 + 0.5);
    expect(insetMetrics.barRect.bottom).toBeLessThanOrEqual(insetMetrics.navRect.top + 0.5);
    expect(insetMetrics.hasHorizontalOverflow).toBe(false);

    const addBox = await measureHitBox(addButton);
    const favBox = await measureHitBox(favLink);
    expect(addBox.hitsTarget).toBe(true);
    expect(favBox.hitsTarget).toBe(true);
    expect(addBox.bottom).toBeLessThanOrEqual(favBox.top);
    expect(favBox.bottom).toBeLessThanOrEqual(812 - 34 + 0.5);
    expect(addBox.left).toBeGreaterThanOrEqual(0);
    expect(addBox.right).toBeLessThanOrEqual(375);

    await saveImplementationScreenshot(page, 'favorites-375-inset-34.png', testInfo);

    await page.touchscreen.tap(addBox.x, addBox.y);
    await expect.poll(() => state.addItemRequests).toHaveLength(1);
    await expect(page).toHaveURL(`/lists/${E2E_LIST_ID}`);

    const favBoxOnLists = await measureHitBox(
      nav.getByRole('link', { name: 'Избранное', exact: true })
    );
    expect(favBoxOnLists.hitsTarget).toBe(true);
    expect(favBoxOnLists.bottom).toBeLessThanOrEqual(812 - 34 + 0.5);
    await page.touchscreen.tap(favBoxOnLists.x, favBoxOnLists.y);
    await expect(page).toHaveURL(FAVORITES_PATH);
  });
});

test.describe('AGE-1486 AC-2 desktop 0px', () => {
  test.use({ viewport: { width: 1280, height: 720 }, hasTouch: false });

  test('hides MobileNav and separates outer bottom 0 from inner padding-bottom 16px @smoke', async ({
    page,
  }) => {
    await mockAuthenticatedFavorites(page);
    await page.goto(FAVORITES_PATH);
    await applySafeAreaInsets(page, { top: 0, left: 0, right: 0, bottom: 0 });

    await page.getByRole('button', { name: /Молоко/ }).click();
    const addButton = page.getByRole('button', { name: 'Добавить', exact: true });
    const selectionBar = page.locator('div.fixed').filter({ has: addButton });

    await expect(page.getByRole('navigation')).toBeHidden();
    await expect(selectionBar).toBeVisible();

    const desktopMetrics = await selectionBar.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        computedBottom: parseFloat(style.bottom),
        computedPaddingBottom: parseFloat(style.paddingBottom),
        rectBottom: rect.bottom,
        viewportHeight: window.innerHeight,
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });

    expect(desktopMetrics.computedBottom).toBe(0);
    expect(Math.abs(desktopMetrics.rectBottom - desktopMetrics.viewportHeight)).toBeLessThanOrEqual(
      1
    );
    expect(desktopMetrics.computedPaddingBottom).toBe(16);
    expect(desktopMetrics.hasHorizontalOverflow).toBe(false);

    const homeBox = await measureHitBox(
      page.getByRole('link', { name: 'На главную', exact: true })
    );
    const logoutBox = await measureHitBox(page.getByRole('button', { name: 'Выйти', exact: true }));
    expect(homeBox.hitsTarget).toBe(true);
    expect(logoutBox.hitsTarget).toBe(true);
  });
});

test.describe('AGE-1486 AC-2 viewport-fit=cover short portrait 375x667', () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });

  test('keeps header controls and both sheet-modal buttons inside top/bottom safe area @smoke', async ({
    page,
  }) => {
    await mockAuthenticatedFavorites(page);
    const variants = Array.from({ length: 30 }, (_, index) => ({
      id: `variant-${index}`,
      name: `Вариант ${index + 1}`,
      nameEn: `Variant ${index + 1}`,
      emoji: '🥛',
      imageUrl: null,
    }));
    await page.route('**/api/products?**', (route) =>
      route.fulfill({ status: 200, json: [{ ...e2eMilkProduct, variants }] })
    );

    await page.goto(FAVORITES_PATH);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      /viewport-fit=cover/
    );

    await applySafeAreaInsets(page, { top: 47, left: 0, right: 0, bottom: 34 });
    const measured = await measureEnvSafeAreaInsets(page);
    expect(measured.top).toBe(47);
    expect(measured.bottom).toBe(34);

    const homeBox = await measureHitBox(
      page.getByRole('link', { name: 'На главную', exact: true })
    );
    const logoutBox = await measureHitBox(page.getByRole('button', { name: 'Выйти', exact: true }));
    expect(homeBox.hitsTarget).toBe(true);
    expect(logoutBox.hitsTarget).toBe(true);
    expect(homeBox.top).toBeGreaterThanOrEqual(47);
    expect(logoutBox.top).toBeGreaterThanOrEqual(47);

    await page.getByRole('button', { name: /Молоко/ }).tap();
    const addBox = await measureHitBox(page.getByRole('button', { name: 'Добавить', exact: true }));
    const favBox = await measureHitBox(
      page.getByRole('navigation').getByRole('link', { name: 'Избранное', exact: true })
    );
    expect(addBox.hitsTarget).toBe(true);
    expect(favBox.hitsTarget).toBe(true);
    expect(addBox.bottom).toBeLessThanOrEqual(favBox.top);
    expect(favBox.bottom).toBeLessThanOrEqual(667 - 34 + 0.5);

    await page.goto(`/categories/${e2eCategory.id}/products?listId=${E2E_LIST_ID}`);
    await applySafeAreaInsets(page, { top: 47, left: 0, right: 0, bottom: 34 });

    const opener = page.getByRole('button', { name: 'Варианты · 30', exact: true });
    await expect(opener).toBeVisible();
    await opener.tap();

    const dialog = page.getByRole('dialog', { name: 'Молоко: варианты' });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    const closeBox = await measureHitBox(
      dialog.getByRole('button', { name: 'Закрыть', exact: true })
    );
    const cancelBox = await measureHitBox(
      dialog.getByRole('button', { name: 'Отмена', exact: true })
    );

    expect(closeBox.hitsTarget).toBe(true);
    expect(cancelBox.hitsTarget).toBe(true);
    expect(closeBox.top).toBeGreaterThanOrEqual(47);
    expect(cancelBox.bottom).toBeLessThanOrEqual(667 - 34 + 0.5);

    await page.touchscreen.tap(cancelBox.x, cancelBox.y);
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe('AGE-1486 AC-2 viewport-fit=cover landscape 812x375', () => {
  test.use({ viewport: { width: 812, height: 375 }, hasTouch: true, isMobile: true });

  test('keeps header and selection bar controls inside side and bottom safe-area insets @smoke', async ({
    page,
  }) => {
    await mockAuthenticatedFavorites(page);
    await page.goto(FAVORITES_PATH);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      /viewport-fit=cover/
    );

    await applySafeAreaInsets(page, { top: 0, left: 44, right: 44, bottom: 21 });
    const measured = await measureEnvSafeAreaInsets(page);
    expect(measured.left).toBe(44);
    expect(measured.right).toBe(44);
    expect(measured.bottom).toBe(21);

    const homeBox = await measureHitBox(
      page.getByRole('link', { name: 'На главную', exact: true })
    );
    const logoutBox = await measureHitBox(page.getByRole('button', { name: 'Выйти', exact: true }));
    expect(homeBox.hitsTarget).toBe(true);
    expect(logoutBox.hitsTarget).toBe(true);
    expect(homeBox.left).toBeGreaterThanOrEqual(44);
    expect(logoutBox.right).toBeLessThanOrEqual(812 - 44);

    await page.getByRole('button', { name: /Молоко/ }).tap();
    const addButton = page.getByRole('button', { name: 'Добавить', exact: true });
    const selectedLabel = page.getByText('Выбрано: 1', { exact: true });
    const addBox = await measureHitBox(addButton);
    const labelBox = await measureHitBox(selectedLabel);

    expect(addBox.hitsTarget).toBe(true);
    expect(labelBox.left).toBeGreaterThanOrEqual(44);
    expect(addBox.right).toBeLessThanOrEqual(812 - 44);
    expect(addBox.bottom).toBeLessThanOrEqual(375 - 21 + 0.5);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  });
});
