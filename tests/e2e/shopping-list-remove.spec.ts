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
