import { expect, test } from '@playwright/test';
import {
  E2E_LIST_ID,
  createShoppingItem,
  e2eCategory,
  e2eMilkProduct,
  mockAuthenticatedShopping,
} from './fixtures/auth';

test.describe('Shopping list smoke flows', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });
  test('adds product via search with authenticated fixture @smoke', async ({ page }) => {
    const state = await mockAuthenticatedShopping(page, [createShoppingItem('seed-item')]);

    await page.goto(`/lists/${E2E_LIST_ID}`);

    await expect(page.getByRole('heading', { name: /E2E список/ })).toBeVisible();
    await page.getByPlaceholder('Поиск товаров...').fill('молоко');

    const result = page.getByRole('button', { name: /Молоко.*Молочные продукты/ });
    await expect(result).toBeVisible();
    const dialogPromise = page.waitForEvent('dialog');
    await Promise.all([
      result.click(),
      dialogPromise.then(async (dialog) => {
        expect(dialog.message()).toContain('Молоко');
        expect(dialog.message()).toContain('добавлен');
        await dialog.accept();
      }),
    ]);

    await expect
      .poll(() => state.addItemRequests)
      .toEqual([{ items: [{ productId: e2eMilkProduct.id, variantId: null }] }]);
    await expect.poll(() => state.items).toHaveLength(2);
  });

  test('adds product from category grid with authenticated fixture @smoke', async ({ page }) => {
    const state = await mockAuthenticatedShopping(page);

    await page.goto(`/categories/${e2eCategory.id}/products?listId=${E2E_LIST_ID}`);

    const main = page.getByRole('main');
    await expect(main.getByTestId('products-grid')).toBeVisible();
    await main.getByTestId('product-card').first().click();
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();

    await expect
      .poll(() => state.addItemRequests)
      .toEqual([{ items: [{ productId: e2eMilkProduct.id, variantId: null }] }]);
    await expect.poll(() => state.items).toHaveLength(1);
    await expect(page).toHaveURL(new RegExp(`/lists/${E2E_LIST_ID}$`));
    await expect(page.getByText('Молоко')).toBeVisible();
  });

  for (const isPurchased of [false, true]) {
    test(`reads a full note and toggles only via its button (purchased: ${isPurchased}) @smoke`, async ({
      page,
    }) => {
      const item = createShoppingItem('note-item');
      item.isPurchased = isPurchased;
      item.note =
        'Купить два пакета молока без лактозы, проверить срок годности и упаковку.\n' +
        // Trailing whitespace must wrap too, not hang outside the card. This
        // catches the overflow across font metrics on both macOS and Linux.
        'Пробелы в конце строки' +
        ' '.repeat(80) +
        '\n' +
        'Если нужного нет, взять другой бренд. ' +
        'ОченьДлинноеСловоБезПробелов'.repeat(8);
      const state = await mockAuthenticatedShopping(page, [item]);
      await page.goto(`/lists/${E2E_LIST_ID}`);

      const toggle = page.getByRole('button', { name: 'Куплено: Молоко', exact: true });
      const noteButton = page.getByRole('button', { name: /^Развернуть комментарий/ });
      const card = toggle.locator('../..');
      await expect(toggle).toHaveAttribute('aria-pressed', String(isPurchased));
      await expect(
        page.getByRole('heading', {
          name: isPurchased ? 'Куплено (1)' : 'Нужно купить',
          exact: true,
        })
      ).toBeVisible();

      await page.getByText('Молоко', { exact: true }).tap();
      await card.tap({ position: { x: 8, y: 24 } });
      await noteButton.tap();
      const expanded = page.getByRole('button', { name: /^Свернуть комментарий/ });
      await expect(expanded).toHaveAttribute('aria-expanded', 'true');
      await expect(toggle).toHaveAttribute('aria-pressed', String(isPurchased));
      expect(state.updateItemRequests).toEqual([]);

      const note = expanded.locator('span').last();
      await expect(note).toHaveText(item.note);
      const layout = await note.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const styles = getComputedStyle(element);
        const range = document.createRange();
        range.selectNodeContents(element);
        const textRects = [...range.getClientRects()];
        return {
          unclipped: element.scrollHeight <= element.clientHeight,
          multiline: rect.height > parseFloat(styles.lineHeight),
          textFits: textRects.every(
            (textRect) => textRect.left >= rect.left - 1 && textRect.right <= rect.right + 1
          ),
          pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });
      expect(layout).toEqual({ unclipped: true, multiline: true, textFits: true, pageFits: true });

      const target = await toggle.boundingBox();
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.height).toBeGreaterThanOrEqual(44);
      // The edge is outside the decorative 32px circle, but inside its touch target.
      await toggle.tap({ position: { x: 3, y: 22 } });
      await expect(toggle).toHaveAttribute('aria-pressed', String(!isPurchased));
      await expect.poll(() => state.items[0].isPurchased).toBe(!isPurchased);

      // Enter the purchase control with Tab once, then keep using the focused
      // control as it moves between sections (no test-side focus repair).
      await page.getByRole('button', { name: 'Удалить товар: Молоко' }).focus();
      await page.keyboard.press('Tab');
      for (const key of ['Enter', 'Space']) {
        await expect(toggle).toBeFocused();
        await page.keyboard.press(key);
        const expected = key === 'Enter' ? isPurchased : !isPurchased;
        await expect(toggle).toHaveAttribute('aria-pressed', String(expected));
        await expect.poll(() => state.items[0].isPurchased).toBe(expected);
      }
      await expect
        .poll(() => state.updateItemRequests)
        .toEqual([
          { itemId: item.id, body: { isPurchased: !isPurchased } },
          { itemId: item.id, body: { isPurchased } },
          { itemId: item.id, body: { isPurchased: !isPurchased } },
        ]);

      await expect(toggle).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(noteButton).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(expanded).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Space');
      await expect(noteButton).toHaveAttribute('aria-expanded', 'false');
      expect(state.updateItemRequests).toHaveLength(3);
    });
  }

  test('edits a note and removes an item without toggling @smoke', async ({ page }) => {
    const item = createShoppingItem('editable-item');
    item.note = 'Старый комментарий';
    const state = await mockAuthenticatedShopping(page, [item]);
    await page.goto(`/lists/${E2E_LIST_ID}`);

    await page.getByRole('button', { name: 'Редактировать комментарий: Молоко' }).tap();
    await page.getByPlaceholder('Заметка к товару...').fill('Новый комментарий');
    await page.getByRole('button', { name: 'Ок', exact: true }).tap();
    await expect(page.getByRole('button', { name: /Развернуть комментарий/ })).toContainText(
      'Новый комментарий'
    );
    await expect
      .poll(() => state.updateItemRequests)
      .toEqual([{ itemId: item.id, body: { note: 'Новый комментарий' } }]);
    expect(state.items[0].isPurchased).toBe(false);

    await page.getByRole('button', { name: 'Удалить товар: Молоко' }).tap();
    await expect.poll(() => state.items).toEqual([]);
    await expect(page.getByRole('heading', { name: 'E2E список пуст' })).toBeVisible();
    expect(state.updateItemRequests).toHaveLength(1);
  });
});
