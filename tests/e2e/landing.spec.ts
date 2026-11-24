import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { mockPublicCatalog } from './fixtures/auth';

const SCREEN_IDS = ['cards', 'list', 'grid'] as const;

type LandingCopy = {
  home: {
    actions: { start: string };
    showcase: Record<(typeof SCREEN_IDS)[number], { alt: string; title: string; caption: string }>;
  };
  nav: { login: string; register: string };
};

function loadCopy(locale: 'ru' | 'en'): LandingCopy {
  const base = path.join(process.cwd(), 'src/i18n/messages', locale);
  return {
    home: JSON.parse(readFileSync(path.join(base, 'home.json'), 'utf8')),
    nav: JSON.parse(readFileSync(path.join(base, 'nav.json'), 'utf8')),
  };
}

for (const locale of ['ru', 'en'] as const) {
  for (const width of [375, 1440] as const) {
    test.describe(`Landing (${locale}, ${width}px)`, () => {
      test.use({
        viewport: { width, height: width === 375 ? 812 : 900 },
        hasTouch: width === 375,
        isMobile: width === 375,
      });

      test('shows product screenshots, single Start CTA, auth links and responsive layout @smoke', async ({
        page,
      }, testInfo) => {
        const copy = loadCopy(locale);
        await mockPublicCatalog(page);
        await page
          .context()
          .addCookies([{ name: 'NEXT_LOCALE', value: locale, domain: 'localhost', path: '/' }]);

        await page.goto('/');
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await page.evaluate(() => document.fonts.ready);

        const main = page.getByRole('main');
        const startLabel = copy.home.actions.start;
        const mainLinks = main.getByRole('link');
        await expect(mainLinks).toHaveCount(1);
        await expect(mainLinks.first()).toHaveAccessibleName(startLabel);
        await expect(mainLinks.first()).toHaveAttribute('href', '/categories');

        // Keep normal login and registration links available in the header.
        const header = page.locator('header');
        await expect(header.getByRole('link', { name: copy.nav.login, exact: true })).toBeVisible();
        await expect(
          header.getByRole('link', { name: copy.nav.register, exact: true })
        ).toBeVisible();

        const boxes = [];
        for (const id of SCREEN_IDS) {
          const figure = page.getByTestId(`landing-screen-${id}`);
          await expect(figure).toBeVisible();
          const img = figure.locator('img');
          await expect(img).toHaveAttribute('alt', copy.home.showcase[id].alt);
          await expect
            .poll(() =>
              img.evaluate(
                (el) => el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0
              )
            )
            .toBe(true);
          const box = await figure.boundingBox();
          expect(box).not.toBeNull();
          boxes.push(box!);
        }

        if (width === 375) {
          // Single screenshot per row on mobile: strictly stacked vertically.
          expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height - 1);
          expect(boxes[2].y).toBeGreaterThanOrEqual(boxes[1].y + boxes[1].height - 1);
        } else {
          // Desktop shows the 3 screenshots across one row.
          expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(8);
          expect(Math.abs(boxes[1].y - boxes[2].y)).toBeLessThan(8);
          expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
          expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
        }

        const overflow = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth > window.innerWidth,
          body: document.body.scrollWidth > window.innerWidth,
        }));
        expect(overflow).toEqual({ document: false, body: false });

        const screenshotPath = testInfo.outputPath(`landing-${width}-${locale}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
        await testInfo.attach(`landing-${width}-${locale}`, {
          path: screenshotPath,
          contentType: 'image/png',
        });

        await mainLinks.first().click();
        await expect(page).toHaveURL(/\/categories$/);
      });
    });
  }
}
