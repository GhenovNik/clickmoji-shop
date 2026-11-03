import { expect, test, type Page } from '@playwright/test';
import {
  createShoppingItem,
  E2E_LIST_ID,
  e2eCategory,
  e2eMilkProduct,
  mockAuthenticatedShopping,
} from './fixtures/auth';
import {
  expectButtonsReachable,
  expectScrollUnchanged,
  mockModalAdmin,
  modalPanel,
  openModal,
  screenshotModal,
  scrollBodyToEnd,
  tapWithoutScroll,
} from './fixtures/modal-footer';

// Local only, all API traffic is handled by mockAuthenticatedShopping + overrides.
// Admin routes require the local-only JWT fixture secret on the Next server:
// AUTH_SECRET=age-1541-local-only NEXTAUTH_SECRET=age-1541-local-only \
//   DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/modal-footer?connect_timeout=1' \
//   npx playwright test tests/e2e/modal-footer.spec.ts --project=chromium --workers=1
// No DB seed, provider request, setContent(), or component-only fake route is used.
const productRoute = `/categories/${e2eCategory.id}/products?listId=${E2E_LIST_ID}`;
const importTitle = 'Импорт списка';
const addTitle = 'Добавить товар';
const createTitle = 'Создать новый список';
const bulkTitle = '📦 Множественное добавление продуктов';
const moveTitle = /Управление товарами:/;
const unavailable =
  'Сервис временно недоступен. Попробуйте ещё раз позднее. Запрос не был сохранён.';

// Enter /lists by the real navigation after SessionProvider has loaded. Direct
// cold navigation hits an unrelated pre-existing loading-session redirect race.
async function goToLists(page: Page) {
  await page.goto('/categories');
  await expect(page.getByText('E2E User', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Списки', exact: true }).tap();
  await expect(page).toHaveURL('/lists');
}

const browserErrors = new WeakMap<Page, string[]>();

for (const height of [667, 812]) {
  test.describe(`AGE-1541 modal footer 375x${height}`, () => {
    test.use({ viewport: { width: 375, height }, hasTouch: true, isMobile: true });

    test.beforeEach(async ({ baseURL, page }) => {
      // In particular, never send the test-only admin JWT to a deployed application.
      expect(new URL(baseURL!).origin).toBe('http://localhost:3000');
      const errors: string[] = [];
      browserErrors.set(page, errors);
      page.on('pageerror', (error) => errors.push(error.message));
    });

    test.afterEach(async ({ page }) => {
      expect(browserErrors.get(page), 'No mock-shape crashes or unhandled browser errors').toEqual(
        []
      );
    });

    test('ImportListModal error keeps BOTH footer actions above navigation @smoke', async ({
      page,
    }, testInfo) => {
      await mockAuthenticatedShopping(
        page,
        Array.from({ length: 20 }, (_, index) => createShoppingItem(`background-${index}`))
      );
      const requests: unknown[] = [];
      await page.route('**/api/lists/import-text', async (route) => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({ status: 503, json: { error: unavailable } });
      });
      await page.goto(`/lists/${E2E_LIST_ID}`);
      const opener = page.getByRole('button', { name: /Импорт из текста/ });
      await expect(opener).toBeVisible();
      // A real scrolled background catches autofocus/body-unlock jumps to the top.
      await page.evaluate(() => window.scrollTo(0, 100));
      const scrollY = await openModal(page, opener, importTitle);
      expect(scrollY).toBe(100);
      const panel = modalPanel(page, importTitle);
      const input = panel.getByRole('textbox');
      await input.fill('Молоко 2 л\nХлеб');
      await expectScrollUnchanged(page, scrollY, 'typing import text');
      // State setup only: requestSubmit invokes the actual React form + mocked API,
      // WITHOUT scrolling the broken footer into view to manufacture the error state.
      await panel.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(panel.getByRole('alert')).toHaveText(unavailable);
      await expectScrollUnchanged(page, scrollY, 'import error response');
      await screenshotModal(page, testInfo, 'import-list-error');
      const cancel = panel.getByRole('button', { name: 'Отмена', exact: true });
      const submit = panel.getByRole('button', { name: /Импортировать/ });
      await expectButtonsReachable(page, [cancel, submit], scrollY);
      await tapWithoutScroll(page, submit, scrollY);
      await expect.poll(() => requests.length).toBe(2);
      expect(requests).toEqual(Array(2).fill({ text: 'Молоко 2 л\nХлеб', listId: E2E_LIST_ID }));
      await expect(panel.getByRole('alert')).toHaveText(unavailable);
      await expectScrollUnchanged(page, scrollY, 'retry error response');
      await tapWithoutScroll(page, cancel, scrollY);
      await expect(page.getByRole('heading', { name: importTitle, exact: true })).toHaveCount(0);
      await expectScrollUnchanged(page, scrollY, 'closing import error');
      await expect(page).toHaveURL(`/lists/${E2E_LIST_ID}`);
    });

    test('ImportListModal partial report keeps retry reachable and retries ONLY failed names @smoke', async ({
      page,
    }, testInfo) => {
      await mockAuthenticatedShopping(page);
      const failedNames = Array.from(
        { length: 18 },
        (_, index) => `Неудавшийся товар ${index + 1}`
      );
      const requests: { text: string; listId: string }[] = [];
      await page.route('**/api/lists/import-text', async (route) => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
          status: 200,
          json: {
            results: {
              added: [{ name: 'Молоко', category: e2eCategory.name }],
              created: [],
              skipped: [],
              failed: failedNames.map((nameRu) => ({
                product: { nameRu },
                reason: 'Повторите позже',
              })),
            },
          },
        });
      });
      await page.goto(`/lists/${E2E_LIST_ID}`);
      const scrollY = await openModal(
        page,
        page.getByRole('button', { name: /Импорт из текста/ }),
        importTitle
      );
      const panel = modalPanel(page, importTitle);
      await panel.getByRole('textbox').fill('Молоко\n' + failedNames.join('\n'));
      await expectScrollUnchanged(page, scrollY, 'typing partial import');
      await panel.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(panel.getByRole('status')).toContainText('Импорт выполнен частично');
      await expectScrollUnchanged(page, scrollY, 'partial report');
      await screenshotModal(page, testInfo, 'import-list-partial-result');
      const retry = panel.getByRole('button', {
        name: 'Проверить и повторить неудавшиеся позиции',
      });
      await expectButtonsReachable(page, [retry], scrollY);
      await tapWithoutScroll(page, retry, scrollY);
      await expect(panel.getByRole('textbox')).toHaveValue(failedNames.join('\n'));
      await expect(panel.getByRole('status')).toContainText(
        'успешно добавленные позиции не отправляются заново'
      );
      await expectScrollUnchanged(page, scrollY, 'reviewing failed subset');
      await screenshotModal(page, testInfo, 'import-list-retry');
      const cancel = panel.getByRole('button', { name: 'Отмена', exact: true });
      const submit = panel.getByRole('button', { name: /Импортировать/ });
      await expectButtonsReachable(page, [cancel, submit], scrollY);
      await tapWithoutScroll(page, submit, scrollY);
      await expect.poll(() => requests.length).toBe(2);
      expect(requests[1]).toEqual({ text: failedNames.join('\n'), listId: E2E_LIST_ID });
      expect(requests[1].text).not.toContain('Молоко');
      await expect(panel.getByRole('status')).toContainText('Импорт выполнен частично');
      await expectScrollUnchanged(page, scrollY, 'partial retry response');
    });

    test('AddProductModal error keeps BOTH footer actions reachable @smoke', async ({
      page,
    }, testInfo) => {
      await mockAuthenticatedShopping(page);
      const requests: unknown[] = [];
      await page.route('**/api/products/smart-create', async (route) => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({ status: 503, json: { error: unavailable } });
      });
      await page.goto(productRoute);
      const scrollY = await openModal(
        page,
        page.getByRole('button', { name: /Добавить свой товар/ }),
        addTitle
      );
      const panel = modalPanel(page, addTitle);
      await panel.getByRole('textbox').fill('Соевое молоко');
      await expectScrollUnchanged(page, scrollY, 'typing product name');
      await panel.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(panel.getByRole('alert')).toHaveText(unavailable);
      await expectScrollUnchanged(page, scrollY, 'product error response');
      await screenshotModal(page, testInfo, 'add-product-error');
      const cancel = panel.getByRole('button', { name: 'Отмена', exact: true });
      const submit = panel.getByRole('button', { name: /Создать/ });
      await expectButtonsReachable(page, [cancel, submit], scrollY);
      await tapWithoutScroll(page, submit, scrollY);
      await expect.poll(() => requests.length).toBe(2);
      expect(requests).toEqual(
        Array(2).fill({ productName: 'Соевое молоко', categoryId: e2eCategory.id })
      );
      await expect(panel.getByRole('alert')).toHaveText(unavailable);
      await expectScrollUnchanged(page, scrollY, 'product retry response');
      await tapWithoutScroll(page, cancel, scrollY);
      await expect(page.getByRole('heading', { name: addTitle, exact: true })).toHaveCount(0);
      await expectScrollUnchanged(page, scrollY, 'closing add product');
      await expect(page).toHaveURL(productRoute);
    });

    test('CreateListModal footer creates and cancels without page scrolling @smoke', async ({
      page,
    }, testInfo) => {
      await mockAuthenticatedShopping(page);
      const requests: unknown[] = [];
      await page.route('**/api/lists', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        requests.push(route.request().postDataJSON());
        await route.fulfill({
          status: 201,
          json: { id: 'created-list', name: 'Мобильный список', isActive: false },
        });
      });
      await goToLists(page);
      const opener = page.getByRole('button', { name: /Новый список/ });
      const scrollY = await openModal(page, opener, createTitle);
      const panel = modalPanel(page, createTitle);
      await panel.getByRole('textbox').fill('Мобильный список');
      await expectScrollUnchanged(page, scrollY, 'typing list name');
      await screenshotModal(page, testInfo, 'create-list');
      const cancel = panel.getByRole('button', { name: 'Отмена', exact: true });
      const submit = panel.getByRole('button', { name: 'Создать', exact: true });
      await expectButtonsReachable(page, [cancel, submit], scrollY);
      await tapWithoutScroll(page, submit, scrollY);
      await expect(page.getByRole('heading', { name: createTitle, exact: true })).toHaveCount(0);
      expect(requests).toEqual([{ name: 'Мобильный список', isActive: false }]);
      await expectScrollUnchanged(page, scrollY, 'create response / close');
      await openModal(page, opener, createTitle);
      await screenshotModal(page, testInfo, 'create-list-cancel');
      await tapWithoutScroll(page, cancel, scrollY);
      await expect(page.getByRole('heading', { name: createTitle, exact: true })).toHaveCount(0);
      expect(requests).toHaveLength(1);
      await expectScrollUnchanged(page, scrollY, 'cancel list creation');
    });

    test('VariantMenu overflow keeps close reachable, scrolls only its body and picks a variant @smoke', async ({
      page,
    }, testInfo) => {
      await mockAuthenticatedShopping(page);
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
      await page.goto(productRoute);
      const opener = page.getByRole('button', { name: 'Варианты · 30', exact: true });
      const title = 'Молоко: варианты';
      const scrollY = await openModal(page, opener, title);
      const panel = page.getByRole('dialog', { name: title });
      await expect(panel.getByTestId('variant-card')).toHaveCount(30);
      await screenshotModal(page, testInfo, 'variant-menu');
      // VariantMenu has no footer in the existing DOM. Its dismiss action is the
      // header close button; test it AND the bottom-row actions rather than inventing a footer.
      const close = panel.getByRole('button', { name: 'Закрыть', exact: true });
      await expectButtonsReachable(page, [close], scrollY);
      const last = panel.getByTestId('variant-card').last();
      await scrollBodyToEnd(page, last, scrollY);
      await screenshotModal(page, testInfo, 'variant-menu-scrolled');
      await expectButtonsReachable(
        page,
        [
          close,
          ...(await panel
            .getByTestId('variant-card')
            .all()
            .then((cards) => cards.slice(-3))),
        ],
        scrollY
      );
      await tapWithoutScroll(page, last, scrollY);
      await expect(panel).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Вариант 30', exact: true })).toBeVisible();
      await expectScrollUnchanged(page, scrollY, 'variant selection / close');
    });

    test('BulkImportModal BOTH footer buttons survive long mobile content @smoke', async ({
      page,
    }, testInfo) => {
      await mockModalAdmin(page);
      const requests: unknown[] = [];
      await page.route('**/api/products/bulk-import', async (route) => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
          status: 200,
          json: { results: { success: [e2eMilkProduct], failed: [] } },
        });
      });
      await page.goto('/admin/products');
      await expect(page).toHaveURL('/admin/products');
      const opener = page.getByRole('button', { name: /Массовый импорт/ });
      const scrollY = await openModal(page, opener, bulkTitle);
      const panel = modalPanel(page, bulkTitle);
      await panel.getByRole('textbox').fill('Молоко\nХлеб\nСыр');
      await expectScrollUnchanged(page, scrollY, 'typing bulk import');
      await screenshotModal(page, testInfo, 'bulk-import');
      const submit = panel.getByRole('button', { name: /Импортировать/ });
      const cancel = panel.getByRole('button', { name: 'Отмена', exact: true });
      await expectButtonsReachable(page, [submit, cancel], scrollY);
      // Existing success alert is browser-owned too; accept it, do not fake DOM geometry.
      const alert = page.waitForEvent('dialog');
      const action = tapWithoutScroll(page, submit, scrollY);
      const dialog = await alert;
      expect(dialog.type()).toBe('alert');
      expect(dialog.message()).toContain('Импорт завершен');
      await dialog.accept();
      await action;
      await expect(page.getByRole('heading', { name: bulkTitle, exact: true })).toHaveCount(0);
      expect(requests).toEqual([{ productNames: ['Молоко', 'Хлеб', 'Сыр'] }]);
      await expectScrollUnchanged(page, scrollY, 'bulk import response / close');
      await openModal(page, opener, bulkTitle);
      await screenshotModal(page, testInfo, 'bulk-import-cancel');
      await tapWithoutScroll(page, cancel, scrollY);
      await expect(page.getByRole('heading', { name: bulkTitle, exact: true })).toHaveCount(0);
      expect(requests).toHaveLength(1);
    });

    test('ProductMoveModal many products keep BOTH footer actions reachable @smoke', async ({
      page,
    }, testInfo) => {
      await mockModalAdmin(page);
      const target = {
        ...e2eCategory,
        id: 'target-category',
        name: 'Другие продукты',
        nameEn: 'Other products',
        order: 2,
        _count: { products: 0 },
      };
      const products = Array.from({ length: 36 }, (_, index) => ({
        ...e2eMilkProduct,
        id: `move-${index}`,
        name: `Продукт ${index + 1}`,
        categoryId: e2eCategory.id,
      }));
      await page.route('**/api/categories', (route) =>
        route.fulfill({
          status: 200,
          json: [
            { ...e2eCategory, nameEn: 'Dairy', order: 1, _count: { products: products.length } },
            target,
          ],
        })
      );
      await page.route('**/api/products?**', (route) =>
        route.fulfill({ status: 200, json: products })
      );
      const requests: unknown[] = [];
      await page.route('**/api/products/move-category', async (route) => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({ status: 200, json: { success: true, movedCount: 1 } });
      });
      await page.goto('/admin/categories');
      await expect(page).toHaveURL('/admin/categories');
      // Scope to the existing mobile DIV card; the desktop TR also has a
      // "Товары" button, but is horizontally clipped on a narrow viewport.
      const card = page.locator(`div[id="category-${e2eCategory.id}"]`);
      await expect(card).toBeVisible();
      // Background setup only, before measuring opening/typing/action scroll.
      await card.evaluate((element) =>
        window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 150)
      );
      const opener = card.getByRole('button', { name: 'Товары', exact: true });
      const scrollY = await openModal(page, opener, moveTitle);
      const panel = modalPanel(page, moveTitle);
      await expect(panel.getByRole('button', { name: /Продукт \d+/, exact: false })).toHaveCount(
        36
      );
      await screenshotModal(page, testInfo, 'product-move-open');
      const close = panel.getByRole('button', { name: 'Закрыть', exact: true });
      await expectButtonsReachable(page, [close], scrollY);
      await tapWithoutScroll(
        page,
        panel.getByRole('button', { name: '🥛 Продукт 1', exact: true }),
        scrollY
      );
      await expectScrollUnchanged(page, scrollY, 'selecting product');
      await panel.getByRole('combobox').selectOption(target.id);
      await expectScrollUnchanged(page, scrollY, 'choosing target category');
      await screenshotModal(page, testInfo, 'product-move-selected');
      const move = panel.getByRole('button', { name: '✓ Переместить (1)', exact: true });
      await expectButtonsReachable(page, [move, close], scrollY);
      const alert = page.waitForEvent('dialog');
      const action = tapWithoutScroll(page, move, scrollY);
      const dialog = await alert;
      expect(dialog.type()).toBe('alert');
      expect(dialog.message()).toContain('успешно перемещены');
      await dialog.accept();
      await action;
      await expect(page.getByRole('heading', { name: moveTitle })).toHaveCount(0);
      expect(requests).toEqual([{ productIds: ['move-0'], targetCategoryId: target.id }]);
      await expectScrollUnchanged(page, scrollY, 'move response / close');
      await openModal(page, opener, moveTitle);
      await screenshotModal(page, testInfo, 'product-move-close');
      await tapWithoutScroll(page, close, scrollY);
      await expect(page.getByRole('heading', { name: moveTitle })).toHaveCount(0);
      expect(requests).toHaveLength(1);
      await expectScrollUnchanged(page, scrollY, 'dismissing product move');
    });

    test('CreateListModal contains focus, Escape closes and restores opener @smoke', async ({
      page,
    }, testInfo) => {
      await mockAuthenticatedShopping(page);
      await goToLists(page);
      const opener = page.getByRole('button', { name: /Новый список/ });
      // Touch does not consistently focus the opener across browser engines.
      await opener.focus();
      const scrollY = await openModal(page, opener, createTitle);
      const panel = modalPanel(page, createTitle);
      const input = panel.getByRole('textbox');
      await expect(input).toBeFocused();
      await input.fill('Проверка фокуса');
      await expectScrollUnchanged(page, scrollY, 'focus test typing');
      await screenshotModal(page, testInfo, 'create-list-focus');
      const cancel = panel.getByRole('button', { name: 'Отмена', exact: true });
      const submit = panel.getByRole('button', { name: 'Создать', exact: true });
      // Geometry remains the primary baseline; focus is a secondary contract.
      await expectButtonsReachable(page, [cancel, submit], scrollY);
      const focusable = panel.locator(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]'
      );
      const first = focusable.first();
      const last = focusable.last();
      await first.evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
      await page.keyboard.press('Shift+Tab');
      await expect.soft(last).toBeFocused();
      await page.keyboard.press('Tab');
      await expect.soft(first).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('heading', { name: createTitle, exact: true })).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expectScrollUnchanged(page, scrollY, 'focus trap / Escape / restore');
    });

    for (const accept of [false, true]) {
      test(`native delete confirmation ${accept ? 'accepts' : 'cancels'} without DB @smoke`, async ({
        page,
      }) => {
        await mockAuthenticatedShopping(page);
        let deleted = false;
        const deletes: string[] = [];
        // Deleting the final list triggers the real client's initialization flow.
        // The base catch-all returns an object, so provide the endpoint's array DTO
        // explicitly; otherwise the disappearing list could falsely pass on a crash.
        await page.route('**/api/lists/init', (route) =>
          route.fulfill({
            status: 200,
            json: [
              {
                id: 'replacement-list',
                name: 'Новый список после удаления',
                isActive: true,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                _count: { items: 0 },
              },
            ],
          })
        );
        await page.route('**/api/lists', async (route) =>
          route.fulfill({
            status: 200,
            json: deleted
              ? []
              : [
                  {
                    id: E2E_LIST_ID,
                    name: 'E2E список',
                    isActive: true,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    _count: { items: 0 },
                  },
                ],
          })
        );
        await page.route(`**/api/lists/${E2E_LIST_ID}`, async (route) => {
          expect(route.request().method()).toBe('DELETE');
          deletes.push(route.request().url());
          deleted = true;
          await route.fulfill({ status: 200, json: { success: true } });
        });
        await goToLists(page);
        const trigger = page.getByRole('button', { name: 'Удалить список', exact: true });
        await expect(trigger).toHaveCount(1);
        const scrollY = await page.evaluate(() => window.scrollY);
        const confirmation = page.waitForEvent('dialog');
        const action = tapWithoutScroll(page, trigger, scrollY);
        const dialog = await confirmation;
        // confirm() is browser-owned. Its OK/Cancel are not DOM buttons and
        // cannot be validated using rect/elementFromPoint or attached as DOM screenshots.
        expect(dialog.type()).toBe('confirm');
        expect(dialog.message()).toBe('Удалить список "E2E список"?');
        if (accept) await dialog.accept();
        else await dialog.dismiss();
        await action;
        await expect(page.getByRole('link', { name: /E2E список/ })).toHaveCount(accept ? 0 : 1);
        await expect(page.getByRole('heading', { name: 'Мои списки', exact: true })).toBeVisible();
        if (accept) {
          await expect(
            page.getByRole('link', { name: /Новый список после удаления/ })
          ).toBeVisible();
        }
        expect(deletes).toHaveLength(accept ? 1 : 0);
        await expectScrollUnchanged(page, scrollY, 'native confirmation result');
        await expect(page).toHaveURL('/lists');
      });
    }
  });
}

// Browser-owned native confirm call sites are intentionally outside the DOM-modal
// geometry contract: list delete (useListsManagement), clear-all (useShoppingListItems),
// history delete (history/page), admin category/product/user delete (useCategories,
// useProducts, useUsers). At this baseline there are six confirm() source calls;
// alerts (including bulk-import and move results) are also browser-owned, not a
// seventh DOM modal. The representative delete test verifies native cancel + accept.
