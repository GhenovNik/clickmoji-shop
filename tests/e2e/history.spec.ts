import { expect, test } from '@playwright/test';
import { E2E_LIST_ID, mockAuthenticatedShopping } from './fixtures/auth';

const completedAt = '2026-10-01T10:00:00.000Z';
const longName = 'ПокупкиНаНеделюБезПробелов'.repeat(4);

for (const locale of ['ru', 'en'] as const) {
  test.describe(`Purchase history (${locale})`, () => {
    test.use({ viewport: { width: 375, height: 1000 }, timezoneId: 'UTC' });

    test('shows saved names, dates and legacy fallback at 375px @smoke', async ({
      page,
    }, testInfo) => {
      await mockAuthenticatedShopping(page);
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
      await page.route('**/api/history', (route) =>
        route.fulfill({
          json: [
            { id: 'named', listName: 'На неделю', completedAt, items: [] },
            { id: 'long', listName: longName, completedAt, items: [] },
            { id: 'legacy', completedAt, items: [] },
          ],
        })
      );
      let restoreBody: unknown;
      await page.route('**/api/history/named/restore', async (route) => {
        restoreBody = route.request().postDataJSON();
        await route.fulfill({
          json: { listId: E2E_LIST_ID, createdCount: 0, skippedCount: 0 },
        });
      });
      await page.goto('/history');

      const date = new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      }).format(new Date(completedAt));
      const namedCard = page.getByRole('button').filter({
        has: page.getByRole('heading', { name: 'На неделю', exact: true }),
      });
      await expect(namedCard).toBeVisible();
      await expect(namedCard.locator('time')).toHaveText(date);
      await expect(namedCard).toContainText(locale === 'ru' ? '0 товаров' : '0 items');
      await expect(page.getByRole('heading', { name: date, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: longName })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      const screenshot = await page.screenshot({
        path: testInfo.outputPath(`history-375-${locale}.png`),
        fullPage: true,
      });
      await testInfo.attach(`history-375-${locale}`, {
        body: screenshot,
        contentType: 'image/png',
      });

      await namedCard.click();
      await page
        .getByRole('button', {
          name: locale === 'ru' ? 'Восстановить в новый список' : 'Restore to a new list',
        })
        .click();
      await expect(page).toHaveURL(`/lists/${E2E_LIST_ID}`);
      expect(restoreBody).toEqual({});
    });
  });
}
