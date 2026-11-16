import { expect, test, type Route } from '@playwright/test';
import { createShoppingItem, E2E_LIST_ID, mockAuthenticatedShopping } from './fixtures/auth';

test.describe('Purchase focus across held network requests', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  for (const initiallyPurchased of [false, true]) {
    for (const outcome of ['success', '503', 'abort'] as const) {
      for (const moveFocus of [false, true]) {
        test(`purchased ${initiallyPurchased}, ${outcome}, user moved focus ${moveFocus} @smoke`, async ({
          page,
        }) => {
          const item = createShoppingItem('focus-item');
          item.isPurchased = initiallyPurchased;
          const state = await mockAuthenticatedShopping(page, [item]);
          const pageErrors: string[] = [];
          page.on('pageerror', (error) => pageErrors.push(error.message));
          const terminalErrors: string[] = [];
          page.on('console', (message) => {
            if (
              message.type() === 'error' &&
              message.text().includes('Error toggling purchased item:')
            ) {
              terminalErrors.push(message.text());
            }
          });
          const putBodies: unknown[] = [];
          let capturePut!: (route: Route) => void;
          const heldPut = new Promise<Route>((resolve) => {
            capturePut = resolve;
          });
          let firstPutHeld = false;
          await page.route(`**/api/lists/${E2E_LIST_ID}/items/${item.id}`, (route) => {
            putBodies.push(route.request().postDataJSON());
            if (!firstPutHeld) {
              firstPutHeld = true;
              capturePut(route);
              return;
            }
            // The N1 retry budget re-issues the same PUT at 1s/2s/4s; answer retries
            // like the held attempt so the retry budget reaches its terminal result.
            if (outcome === '503') {
              void route.fulfill({ status: 503, json: { error: 'Synthetic unavailable' } });
            } else if (outcome === 'abort') {
              void route.abort('aborted');
            } else {
              void route.fulfill({
                status: 200,
                json: { ...item, isPurchased: !initiallyPurchased },
              });
            }
          });
          await page.goto(`/lists/${E2E_LIST_ID}`);
          const toggle = page.getByRole('button', { name: 'Куплено: Молоко', exact: true });
          await expect(toggle).toHaveAttribute('aria-pressed', String(initiallyPurchased));
          await page.getByRole('button', { name: 'Удалить товар: Молоко' }).focus();
          await page.keyboard.press('Tab');
          await expect(toggle).toBeFocused();
          await page.keyboard.press('Enter');
          const put = await heldPut;
          expect(put.request().postDataJSON()).toEqual({ isPurchased: !initiallyPurchased });
          await expect(toggle).toHaveAttribute('aria-pressed', String(!initiallyPurchased));
          // No response yet: focus must follow the optimistic DOM commit, not HTTP success.
          await expect(toggle).toBeFocused();
          expect(state.items[0].isPurchased).toBe(initiallyPurchased);
          const neighbour = page.getByRole('button', { name: /Импорт из текста/ });
          if (moveFocus) {
            await page.keyboard.press('Shift+Tab');
            await expect(page.getByRole('button', { name: 'Удалить товар: Молоко' })).toBeFocused();
            // Move beyond the item to a stable control that survives its rollback.
            await neighbour.focus();
          }
          const readsBeforeResponse = state.listRequests;
          if (outcome === 'success') {
            state.items[0].isPurchased = !initiallyPurchased;
            await put.fulfill({ status: 200, json: state.items[0] });
          } else if (outcome === '503') {
            await put.fulfill({ status: 503, json: { error: 'Synthetic unavailable' } });
          } else {
            await put.abort('aborted');
          }
          if (outcome === 'success') {
            await expect
              .poll(() => state.listRequests, { timeout: 12_000 })
              .toBeGreaterThan(readsBeforeResponse);
            expect(putBodies).toEqual([{ isPurchased: !initiallyPurchased }]);
          } else {
            await expect.poll(() => terminalErrors.length, { timeout: 12_000 }).toBe(1);
            expect(putBodies).toEqual(
              Array.from({ length: 4 }, () => ({ isPurchased: !initiallyPurchased }))
            );
          }
          await expect(toggle).toHaveAttribute('aria-pressed', String(!initiallyPurchased));
          await expect(moveFocus ? neighbour : toggle).toBeFocused();
          expect(pageErrors).toEqual([]);
        });
      }
    }
  }
});
