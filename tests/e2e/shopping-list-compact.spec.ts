import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { E2E_LIST_ID, mockAuthenticatedShopping } from './fixtures/auth';
import {
  COMPACT_NOTE,
  compactAllIds,
  compactGroups,
  compactPendingIds,
  compactPurchasedId,
  createCompactItems,
} from './fixtures/compact';

type View = 'list' | 'grid';
const purchasedName = /^Куплено \(1\)/;
const purchasedVegetablesName = /^🥬 Овощи \(1\)/;

function item(page: Page, id: string) {
  return page.locator(`[data-testid="shopping-item"][data-item-id="${id}"]`);
}

function viewControls(page: Page) {
  return page.getByRole('group', { name: 'Вид списка', exact: true });
}

async function selectView(page: Page, view: View) {
  const controls = viewControls(page);
  const selected = controls.getByRole('button', {
    name: view === 'list' ? 'Список' : 'Плитка',
    exact: true,
  });
  await selected.click();
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await expect(
    controls.getByRole('button', { name: view === 'list' ? 'Плитка' : 'Список', exact: true })
  ).toHaveAttribute('aria-pressed', 'false');
}

async function openCompactList(page: Page) {
  const state = await mockAuthenticatedShopping(page, createCompactItems());
  await page.goto(`/lists/${E2E_LIST_ID}`);
  await expect(page.getByRole('heading', { name: /E2E список/ })).toBeVisible();
  // A feature assertion first: failures on the base revision must not be caused
  // by fixture setup or an invented localStorage key.
  await expect(viewControls(page)).toBeVisible();
  await expect(
    viewControls(page).getByRole('button', { name: 'Список', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    viewControls(page).getByRole('button', { name: 'Плитка', exact: true })
  ).toHaveAttribute('aria-pressed', 'false');
  return state;
}

async function expectOnlyItems(page: Page, expectedIds = compactAllIds) {
  await expect(page.getByTestId('shopping-item')).toHaveCount(expectedIds.length);
  const actualIds = await page
    .getByTestId('shopping-item')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-item-id')).sort()
    );
  expect(actualIds).toEqual([...expectedIds].sort());
  for (const id of expectedIds) {
    await expect(item(page, id)).toHaveCount(1);
    await expect(item(page, id)).toBeVisible();
  }
  const duplicateIds = await page.locator('[id]').evaluateAll((elements) => {
    const ids = elements.map((element) => element.id).filter(Boolean);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicateIds, 'selected view must not mount a hidden second copy').toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      document: document.documentElement.scrollWidth <= window.innerWidth,
      body: document.body.scrollWidth <= window.innerWidth,
    }))
  ).toEqual({ document: true, body: true });
}

async function expectSameRow(left: Locator, right: Locator) {
  const leftBox = await left.boundingBox();
  const rightBox = await right.boundingBox();
  expect(leftBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  expect(Math.min(leftBox!.y + leftBox!.height, rightBox!.y + rightBox!.height)).toBeGreaterThan(
    Math.max(leftBox!.y, rightBox!.y)
  );
  expect(leftBox!.x + leftBox!.width).toBeLessThanOrEqual(rightBox!.x + 1);
}

async function expectFullNote(noteButton: Locator) {
  await expect(noteButton).toHaveAttribute('aria-expanded', 'true');
  const note = noteButton.locator('span').last();
  await expect(note).toHaveText(COMPACT_NOTE);
  const layout = await note.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      unclipped: element.scrollHeight <= element.clientHeight,
      multiline: rect.height > parseFloat(getComputedStyle(element).lineHeight),
      textFits: [...range.getClientRects()].every(
        (textRect) => textRect.left >= rect.left - 1 && textRect.right <= rect.right + 1
      ),
    };
  });
  expect(layout).toEqual({ unclipped: true, multiline: true, textFits: true });
}

async function attachEvidence(
  page: Page,
  testInfo: TestInfo,
  width: number,
  view: View,
  expanded = false
) {
  await page.evaluate(() => document.fonts.ready);
  const name = `shopping-compact-${width}-${view}${expanded ? '-expanded' : ''}.png`;
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const width of [375, 1440]) {
  test.describe(`Compact shopping at ${width}px`, () => {
    test.use({
      viewport: { width, height: 1000 },
      hasTouch: width === 375,
      isMobile: width === 375,
      locale: 'ru-RU',
    });

    for (const view of ['list', 'grid'] as const) {
      test(`${view}: compact layout, one mounted view and full-note evidence @smoke`, async ({
        page,
      }, testInfo) => {
        const state = await openCompactList(page);
        const toBuy = page.getByRole('region', { name: 'Купить', exact: true });
        await expect(toBuy).toBeVisible();
        await expect(toBuy.getByTestId('shopping-item')).toHaveCount(7);
        for (const group of compactGroups) {
          await expect(toBuy.getByRole('button', { name: group.name })).toHaveAttribute(
            'aria-expanded',
            'true'
          );
        }
        await expect(page.getByRole('button', { name: purchasedName })).toHaveAttribute(
          'aria-expanded',
          'true'
        );
        await expect(page.getByRole('button', { name: purchasedVegetablesName })).toHaveAttribute(
          'aria-expanded',
          'true'
        );
        if (view === 'grid') await selectView(page, view);
        await expectOnlyItems(page);

        await expectSameRow(
          page.getByRole('heading', { name: /E2E список/ }),
          page.getByText('Осталось: 7', { exact: true })
        );
        await expectSameRow(
          page.getByPlaceholder('Поиск товаров...'),
          page.getByRole('button', { name: /Импорт из текста/ })
        );
        await expectSameRow(
          toBuy.getByRole('heading', { name: 'Купить', exact: true }),
          viewControls(page)
        );
        await expectNoHorizontalOverflow(page);

        const listBounds = [];
        for (const group of compactGroups) {
          const boxes = [];
          for (const product of group.products) {
            const box = await item(page, product.id).boundingBox();
            expect(box).not.toBeNull();
            boxes.push(box!);
            listBounds.push(box!);
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          }
          if (view === 'list') {
            for (const [index, box] of boxes.entries()) {
              expect(box.height, 'collapsed notes must not make rows tall').toBeGreaterThanOrEqual(
                56
              );
              expect(box.height).toBeLessThanOrEqual(64);
              expect(Math.abs(box.x - boxes[0].x)).toBeLessThanOrEqual(1);
              expect(Math.abs(box.width - boxes[0].width)).toBeLessThanOrEqual(1);
              if (index > 0) {
                const gap = box.y - (boxes[index - 1].y + boxes[index - 1].height);
                expect(gap).toBeGreaterThanOrEqual(4);
                expect(gap).toBeLessThanOrEqual(8);
              }
            }
          } else {
            const columns = width === 375 ? 2 : 3;
            // Inspect the containing layout, not the item's own internal grid.
            const grid = await item(page, group.products[0].id).evaluate((element) => {
              let parent = element.parentElement;
              while (parent && getComputedStyle(parent).display !== 'grid') {
                parent = parent.parentElement;
              }
              return parent ? getComputedStyle(parent).gridTemplateColumns.split(/\s+/) : [];
            });
            expect(grid).toHaveLength(columns);
            for (const [index, box] of boxes.entries()) {
              expect(Math.abs(box.width - boxes[0].width)).toBeLessThanOrEqual(1);
              if (index > 0 && index < columns) {
                expect(Math.abs(box.y - boxes[0].y)).toBeLessThanOrEqual(1);
                expect(box.x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width);
              }
              if (index >= columns) {
                expect(Math.abs(box.x - boxes[index % columns].x)).toBeLessThanOrEqual(1);
                expect(box.y).toBeGreaterThanOrEqual(
                  boxes[index - columns].y + boxes[index - columns].height
                );
              }
            }
          }
        }
        if (view === 'list') {
          for (const box of listBounds) {
            expect(Math.abs(box.x - listBounds[0].x)).toBeLessThanOrEqual(1);
            expect(Math.abs(box.width - listBounds[0].width)).toBeLessThanOrEqual(1);
          }
        }
        if (width === 375) {
          const viewport = await page.evaluate(() => {
            const bottomNav = [...document.querySelectorAll('nav')].find((nav) => {
              const rect = nav.getBoundingClientRect();
              return (
                getComputedStyle(nav).position === 'fixed' &&
                rect.height > 0 &&
                rect.bottom >= innerHeight - 1
              );
            });
            return { scrollY, navTop: bottomNav?.getBoundingClientRect().top ?? null };
          });
          expect(viewport.scrollY).toBe(0);
          expect(viewport.navTop, 'mobile bottom navigation must be present').not.toBeNull();
          const sectionBox = await toBuy.boundingBox();
          expect(sectionBox!.y).toBeGreaterThanOrEqual(0);
          expect(
            sectionBox!.y + sectionBox!.height,
            'all seven pending items fit without scrolling'
          ).toBeLessThanOrEqual(viewport.navTop!);
          for (const box of listBounds)
            expect(box.y + box.height).toBeLessThanOrEqual(viewport.navTop!);
        }

        await attachEvidence(page, testInfo, width, view);
        const beef = item(page, 'compact-beef');
        await expect(beef.getByRole('button', { name: /^Развернуть комментарий/ })).toHaveAttribute(
          'aria-expanded',
          'false'
        );
        await beef.getByRole('button', { name: /^Развернуть комментарий/ }).click();
        await expectFullNote(beef.getByRole('button', { name: /^Свернуть комментарий/ }));
        await expectNoHorizontalOverflow(page);
        expect(state.updateItemRequests).toEqual([]);
        await attachEvidence(page, testInfo, width, view, true);
      });
    }

    test('grid and independently collapsed pending/purchased groups survive reload @smoke', async ({
      page,
    }) => {
      await openCompactList(page);
      await selectView(page, 'grid');
      const toBuy = page.getByRole('region', { name: 'Купить', exact: true });
      const vegetables = toBuy.getByRole('button', { name: compactGroups[0].name });
      const purchased = page.getByRole('button', { name: purchasedName });
      const purchasedVegetables = page.getByRole('button', { name: purchasedVegetablesName });
      await vegetables.click();
      await expect(vegetables).toHaveAttribute('aria-expanded', 'false');
      const withoutPendingVegetables = compactAllIds.filter(
        (id) => !compactGroups[0].products.some((product) => product.id === id)
      );
      await expectOnlyItems(page, withoutPendingVegetables);
      await expect(purchasedVegetables).toHaveAttribute('aria-expanded', 'true');
      await purchasedVegetables.click();
      await expect(purchasedVegetables).toHaveAttribute('aria-expanded', 'false');
      await expect(item(page, compactPurchasedId)).toHaveCount(0);
      await purchased.click();
      await expect(purchased).toHaveAttribute('aria-expanded', 'false');
      await expect(purchasedVegetables).toHaveCount(0);
      await page.reload();
      await expect(
        viewControls(page).getByRole('button', { name: 'Плитка', exact: true })
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        viewControls(page).getByRole('button', { name: 'Список', exact: true })
      ).toHaveAttribute('aria-pressed', 'false');
      await expect(vegetables).toHaveAttribute('aria-expanded', 'false');
      await expect(purchased).toHaveAttribute('aria-expanded', 'false');
      await expectOnlyItems(
        page,
        withoutPendingVegetables.filter((id) => id !== compactPurchasedId)
      );
      for (const group of compactGroups.slice(1)) {
        await expect(toBuy.getByRole('button', { name: group.name })).toHaveAttribute(
          'aria-expanded',
          'true'
        );
      }
      await purchased.click();
      await expect(purchasedVegetables).toHaveAttribute('aria-expanded', 'false');
      await vegetables.click();
      await expectOnlyItems(page, compactPendingIds);
      await expect(purchasedVegetables).toHaveAttribute('aria-expanded', 'false');
      await purchasedVegetables.click();
      await expectOnlyItems(page);
      await selectView(page, 'list');
      await expectOnlyItems(page);
    });
  });
}

test.describe('Compact touch and keyboard behavior', () => {
  test.use({
    viewport: { width: 375, height: 1000 },
    hasTouch: true,
    isMobile: true,
    locale: 'ru-RU',
  });

  for (const view of ['list', 'grid'] as const) {
    for (const initiallyPurchased of [false, true]) {
      test(`${view}: ${initiallyPurchased ? 'purchased' : 'pending'} note and card never purchase, only the 44px circle does @smoke`, async ({
        page,
      }) => {
        const state = await openCompactList(page);
        if (view === 'grid') await selectView(page, view);
        const id = initiallyPurchased ? compactPurchasedId : 'compact-beef';
        const name = initiallyPurchased ? 'Горошек' : 'Говядина';
        const emoji = initiallyPurchased ? '🫛' : '🐄';
        const card = item(page, id);
        const toggle = page.getByRole('button', { name: `Куплено: ${name}`, exact: true });
        await card.getByText(name, { exact: true }).tap();
        await card.getByText(emoji, { exact: true }).tap();
        await card.tap({ position: { x: 2, y: 2 } });
        await card.getByRole('button', { name: /^Развернуть комментарий/ }).tap();
        const expanded = card.getByRole('button', { name: /^Свернуть комментарий/ });
        await expectFullNote(expanded);
        await expect(toggle).toHaveAttribute('aria-pressed', String(initiallyPurchased));
        expect(state.updateItemRequests).toEqual([]);
        await expectNoHorizontalOverflow(page);
        await expanded.tap();
        await expect(card.getByRole('button', { name: /^Развернуть комментарий/ })).toHaveAttribute(
          'aria-expanded',
          'false'
        );
        expect(state.updateItemRequests).toEqual([]);
        const target = await toggle.boundingBox();
        expect(target!.width).toBeGreaterThanOrEqual(44);
        expect(target!.height).toBeGreaterThanOrEqual(44);
        await toggle.tap({ position: { x: 3, y: 22 } });
        await expect(toggle).toHaveAttribute('aria-pressed', String(!initiallyPurchased));
        await expect
          .poll(() => state.items.find((entry) => entry.id === id)?.isPurchased)
          .toBe(!initiallyPurchased);
        await expect
          .poll(() => state.updateItemRequests)
          .toEqual([{ itemId: id, body: { isPurchased: !initiallyPurchased } }]);
        const toBuy = page.getByRole('region', { name: 'Купить', exact: true });
        if (initiallyPurchased) {
          await expect(toBuy.getByRole('button', { name: /^🥬 Овощи \(4\)/ })).toBeVisible();
          await expect(toBuy.getByTestId('shopping-item')).toHaveCount(8);
        } else {
          await expect(toBuy.getByRole('button', { name: /^🥩 Мясо \(2\)/ })).toBeVisible();
          await expect(page.getByRole('button', { name: /^🥩 Мясо \(1\)/ })).toBeVisible();
          await expect(page.getByRole('button', { name: /^Куплено \(2\)/ })).toBeVisible();
          await expect(toBuy.getByTestId('shopping-item')).toHaveCount(6);
        }
        await expectOnlyItems(page);
      });
    }
  }

  for (const outcome of ['success', '503'] as const) {
    test(`grid keyboard focus follows optimistic purchase and ${outcome === 'success' ? 'success' : 'rollback'} @smoke`, async ({
      page,
    }) => {
      const state = await openCompactList(page);
      await selectView(page, 'grid');
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      let capturePut!: (route: Route) => void;
      const heldPut = new Promise<Route>((resolve) => {
        capturePut = resolve;
      });
      await page.route(
        `**/api/lists/${E2E_LIST_ID}/items/compact-beef`,
        (route) => {
          capturePut(route);
        },
        { times: 1 }
      );
      const toggle = page.getByRole('button', { name: 'Куплено: Говядина', exact: true });
      await page.getByRole('button', { name: 'Удалить товар: Говядина', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(toggle).toBeFocused();
      await page.keyboard.press('Enter');
      const put = await heldPut;
      expect(put.request().method()).toBe('PUT');
      expect(put.request().postDataJSON()).toEqual({ isPurchased: true });
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(toggle).toBeFocused();
      const beef = state.items.find((entry) => entry.id === 'compact-beef')!;
      expect(beef.isPurchased).toBe(false);
      const readsBeforeResponse = state.listRequests;
      if (outcome === 'success') {
        beef.isPurchased = true;
        await put.fulfill({ status: 200, json: beef });
      } else {
        await put.fulfill({ status: 503, json: { error: 'Synthetic unavailable' } });
      }
      await expect.poll(() => state.listRequests).toBeGreaterThan(readsBeforeResponse);
      await expect(toggle).toHaveAttribute('aria-pressed', String(outcome === 'success'));
      await expect(toggle).toBeFocused();
      // No focus repair: Space must work on the same item after its DOM move.
      await page.keyboard.press('Space');
      await expect(toggle).toHaveAttribute('aria-pressed', String(outcome !== 'success'));
      await expect.poll(() => beef.isPurchased).toBe(outcome !== 'success');
      await expect(toggle).toBeFocused();
      await expectOnlyItems(page);
      expect(pageErrors).toEqual([]);
    });
  }

  test('new view controls use translated English accessible names @smoke', async ({ page }) => {
    await openCompactList(page);
    await page
      .getByRole('group', { name: /Сменить язык/ })
      .getByRole('button', { name: 'en', exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const list = page.getByRole('button', { name: 'List', exact: true });
    const grid = page.getByRole('button', { name: 'Grid', exact: true });
    await expect(list).toHaveAttribute('aria-pressed', 'true');
    await expect(grid).toHaveAttribute('aria-pressed', 'false');
    await grid.click();
    await expect(grid).toHaveAttribute('aria-pressed', 'true');
    await expect(list).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('region', { name: 'To buy', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Purchased \(1\)/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(page.getByRole('button', { name: /^🥬 Vegetables \(3\)/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expectOnlyItems(page);
  });
});
