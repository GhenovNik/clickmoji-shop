import { expect, test } from '@playwright/test';
import { createShoppingItem, E2E_LIST_ID, mockAuthenticatedShopping } from './fixtures/auth';

for (const width of [375, 1440]) {
  test.describe(`Expanded shopping note evidence at ${width}px`, () => {
    test.use({ viewport: { width, height: 1000 }, hasTouch: width === 375 });
    for (const isPurchased of [false, true]) {
      test(`${isPurchased ? 'purchased' : 'to-buy'} full comment @smoke`, async ({
        page,
      }, testInfo) => {
        const item = createShoppingItem('evidence-item');
        item.isPurchased = isPurchased;
        item.note =
          'Купить два пакета молока без лактозы, проверить срок годности и целостность упаковки.\n' +
          'Если нужного бренда нет, выбрать другой без добавленного сахара. Обязательно сохранить чек.\n' +
          'ДлинноеСловоБезПробелов'.repeat(6);
        await mockAuthenticatedShopping(page, [item]);
        await page.goto(`/lists/${E2E_LIST_ID}`);
        await page.getByRole('button', { name: /^Развернуть комментарий/ }).click();
        const expanded = page.getByRole('button', { name: /^Свернуть комментарий/ });
        await expect(expanded).toHaveAttribute('aria-expanded', 'true');
        await expect(expanded.locator('span').last()).toHaveText(item.note);
        await expect(page.getByRole('button', { name: 'Куплено: Молоко' })).toHaveAttribute(
          'aria-pressed',
          String(isPurchased)
        );
        await page.evaluate(() => document.fonts.ready);
        const screenshot = await page.screenshot({
          path: testInfo.outputPath(
            `shopping-note-${width}-${isPurchased ? 'purchased' : 'to-buy'}.png`
          ),
          fullPage: true,
        });
        await testInfo.attach('expanded-comment', { body: screenshot, contentType: 'image/png' });
      });
    }
  });
}
