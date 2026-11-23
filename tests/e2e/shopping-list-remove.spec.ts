import { expect, test, type Page } from '@playwright/test';
import { createShoppingItem, E2E_LIST_ID, mockAuthenticatedShopping } from './fixtures/auth';

async function swipe(page: Page, x: number, y: number, dx: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * step) / 8, y: y + (dy * step) / 8 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('mobile item removal', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  for (const view of ['list', 'grid'] as const) {
    test(`${view}: confirmation excludes covered controls from keyboard and accessibility tree @smoke`, async ({
      page,
    }) => {
      const milk = createShoppingItem('removal-item');
      milk.note = 'Проверить срок';
      const bread = createShoppingItem('neighbour');
      bread.product.name = 'Хлеб';
      const state = await mockAuthenticatedShopping(page, [milk, bread]);
      await page.goto(`/lists/${E2E_LIST_ID}`);
      if (view === 'grid') await page.getByRole('button', { name: 'Плитка' }).click();
      const row = page.locator('[data-item-id="removal-item"]');
      const remove = row.getByRole('button', { name: 'Удалить товар: Молоко' });
      await remove.focus();
      await page.keyboard.press('Enter');
      const cancel = row.getByRole('button', { name: 'Отмена' });
      await expect(cancel).toBeFocused();
      await expect(row.getByRole('button', { name: 'Куплено: Молоко' })).toHaveCount(0);
      await expect(
        row.getByRole('button', { name: 'Редактировать комментарий: Молоко' })
      ).toHaveCount(0);
      await expect(row.getByRole('button', { name: /Развернуть комментарий/ })).toHaveCount(0);
      await page.keyboard.press('Shift+Tab');
      expect(await row.evaluate((element) => element.contains(document.activeElement))).toBe(false);
      expect(state.updateItemRequests).toEqual([]);
      await cancel.focus();
      await page.keyboard.press('Tab');
      await expect(row.getByRole('button', { name: 'Удалить', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      const neighbour = page.getByRole('button', { name: 'Куплено: Хлеб' });
      await neighbour.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => state.updateItemRequests.length).toBe(1);
      expect(state.updateItemRequests[0].itemId).toBe('neighbour');
      expect(state.items.find((item) => item.id === 'removal-item')?.isPurchased).toBe(false);
      await cancel.focus();
      await page.keyboard.press('Enter');
      await expect(remove).toBeFocused();
      expect(state.updateItemRequests).toHaveLength(1);
      expect(state.items.find((item) => item.id === 'removal-item')).toBeTruthy();
    });

    test(`${view}: swipe asks before removing; scrolling and cancellation do not remove @smoke`, async ({
      page,
    }) => {
      const item = createShoppingItem('removal-item');
      const state = await mockAuthenticatedShopping(page, [item]);
      await page.goto(`/lists/${E2E_LIST_ID}`);
      if (view === 'grid') await page.getByRole('button', { name: 'Плитка' }).tap();
      const row = page.getByTestId('shopping-item');
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      const x = box!.x + 45;
      const y = box!.y + box!.height / 2;

      await swipe(page, x, y, -5, -70);
      await expect(page.getByText('Удалить товар?')).toHaveCount(0);
      expect(state.items).toHaveLength(1);
      await row.scrollIntoViewIfNeeded();
      const current = await row.boundingBox();
      await swipe(page, current!.x + 80, current!.y + current!.height / 2, -70, 0);
      await expect(page.getByText('Удалить товар?')).toBeVisible();
      expect(state.items).toHaveLength(1);
      await page.getByRole('button', { name: 'Отмена', exact: true }).tap();
      await expect(page.getByText('Удалить товар?')).toHaveCount(0);
      await page.getByRole('button', { name: 'Удалить товар: Молоко' }).tap();
      await page.getByRole('button', { name: 'Удалить', exact: true }).tap();
      await expect.poll(() => state.items).toEqual([]);
    });
  }
});
