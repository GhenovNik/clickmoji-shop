import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { E2E_AUTH_COOKIE, mockAuthenticatedShopping } from './auth';

// Public test-only value, NOT an application credential. Start the local server with
// AUTH_SECRET=age-1541-local-only NEXTAUTH_SECRET=age-1541-local-only.
const LOCAL_ADMIN_SECRET = 'age-1541-local-only';

export async function mockModalAdmin(page: Page) {
  await mockAuthenticatedShopping(page);
  // The existing proxy intentionally treats the bypass cookie as USER, never ADMIN.
  // A locally signed NextAuth fixture exercises the real /admin routes without a DB
  // or changing the production proxy. All browser API calls remain intercepted.
  await page.context().clearCookies({ name: E2E_AUTH_COOKIE });
  await page.context().addCookies([
    {
      name: 'next-auth.session-token',
      value: await encode({
        secret: LOCAL_ADMIN_SECRET,
        token: {
          id: 'modal-admin',
          sub: 'modal-admin',
          role: 'ADMIN',
          name: 'Modal fixture admin',
        },
        maxAge: 3600,
      }),
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: false,
    },
  ]);
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: 200,
      json: {
        user: { id: 'modal-admin', name: 'Modal fixture admin', role: 'ADMIN' },
        expires: '2099-01-01T00:00:00.000Z',
      },
    })
  );
}

// Only VariantMenu has role=dialog before AGE-1541. Find the existing real panel
// through its heading + form/content, not future shared classes/roles/test IDs.
export function modalPanel(page: Page, title: string | RegExp) {
  return page
    .getByRole('heading', { level: 2, name: title, exact: typeof title === 'string' })
    .locator('xpath=ancestor::div[.//textarea or .//input or .//h3 or .//*[@role="status"]][1]');
}

export async function expectScrollUnchanged(page: Page, scrollY: number, phase: string) {
  expect.soft(await page.evaluate(() => window.scrollY), `window.scrollY: ${phase}`).toBe(scrollY);
}

export async function screenshotModal(page: Page, testInfo: TestInfo, name: string) {
  const viewport = page.viewportSize()!;
  const filename = `modal-footer-${viewport.width}x${viewport.height}-${name}.png`;
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

export async function buttonGeometry(button: Locator) {
  await expect(button).toHaveCount(1);
  return button.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      x,
      y,
      // A span/svg inside a button is a valid hit; a nav/link/overlay is not.
      centerHitsButton: top?.closest('button') === element,
      hit: top?.outerHTML.slice(0, 350) ?? null,
    };
  });
}

export async function expectButtonsReachable(page: Page, buttons: Locator[], scrollY: number) {
  let reachable = true;
  // Check EVERY footer action before failing, so a hidden cancel cannot mask submit.
  for (const button of buttons) {
    const geometry = await buttonGeometry(button);
    const label = (await button.innerText()) || (await button.getAttribute('aria-label'));
    const description = `${label}: ${JSON.stringify(geometry)}`;
    expect.soft(geometry.width, description).toBeGreaterThan(0);
    expect.soft(geometry.height, description).toBeGreaterThan(0);
    expect.soft(geometry.left, description).toBeGreaterThanOrEqual(0);
    expect.soft(geometry.top, description).toBeGreaterThanOrEqual(0);
    expect.soft(geometry.right, description).toBeLessThanOrEqual(geometry.viewportWidth);
    expect.soft(geometry.bottom, description).toBeLessThanOrEqual(geometry.viewportHeight);
    expect.soft(geometry.centerHitsButton, description).toBe(true);
    const valid =
      geometry.width > 0 &&
      geometry.height > 0 &&
      geometry.left >= 0 &&
      geometry.top >= 0 &&
      geometry.right <= geometry.viewportWidth &&
      geometry.bottom <= geometry.viewportHeight &&
      geometry.centerHitsButton;
    reachable = reachable && valid;
    // Never let Playwright scroll a broken footer into view and turn RED into GREEN.
    // Trial actionability is supplementary evidence, AFTER viewport + hit testing.
    if (valid && (await button.isEnabled())) {
      await button.click({ trial: true });
      await expectScrollUnchanged(page, scrollY, `trial ${label}`);
    }
  }
  expect(
    reachable,
    'All modal actions must be inside the viewport and above mobile navigation'
  ).toBe(true);
}

export async function tapWithoutScroll(page: Page, button: Locator, scrollY: number) {
  await expectButtonsReachable(page, [button], scrollY);
  const { x, y } = await buttonGeometry(button);
  // Raw touch coordinates cannot auto-scroll and cannot silently click an offscreen button.
  await page.touchscreen.tap(x, y);
  await expectScrollUnchanged(page, scrollY, 'touch action');
}

export async function openModal(page: Page, opener: Locator, title: string | RegExp) {
  const scrollY = await page.evaluate(() => window.scrollY);
  await tapWithoutScroll(page, opener, scrollY);
  await expect(page.getByRole('heading', { level: 2, name: title })).toHaveCount(1);
  await expectScrollUnchanged(page, scrollY, 'opening / autofocus');
  return scrollY;
}

export async function scrollBodyToEnd(page: Page, lastItem: Locator, scrollY: number) {
  // Explicitly scroll only an overflowing modal CONTENT ancestor, never the document
  // and never a footer. This is not used as evidence that footer controls are reachable.
  const scrolled = await lastItem.evaluate((item) => {
    let parent = item.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const { overflowY } = getComputedStyle(parent);
      if (/(auto|scroll)/.test(overflowY) && parent.scrollHeight > parent.clientHeight) {
        parent.scrollTop = parent.scrollHeight;
        return true;
      }
      parent = parent.parentElement;
    }
    return false;
  });
  expect(scrolled, 'Many variants/products must have a bounded, internally scrollable body').toBe(
    true
  );
  await expectScrollUnchanged(page, scrollY, 'scrolling modal content');
}

// Headless engines do not open a real iOS software keyboard. Model the Visual
// Viewport resize + pan events on its REAL EventTarget, without modifying app CSS.
export async function expectKeyboardFooter(page: Page, buttons: Locator[], scrollY: number) {
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', { configurable: true, value: 420 });
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 80 });
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
  });
  for (const button of buttons) {
    const { top, bottom, centerHitsButton } = await buttonGeometry(button);
    expect(top, 'Footer above the visual viewport top').toBeGreaterThanOrEqual(80);
    expect(bottom, 'Footer above keyboard at visualViewport bottom').toBeLessThanOrEqual(500);
    expect(centerHitsButton).toBe(true);
  }
  await expectScrollUnchanged(page, scrollY, 'keyboard resize and viewport pan');
}
