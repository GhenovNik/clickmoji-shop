import { expect, test } from '@playwright/test';
import { createShoppingItem, E2E_LIST_ID, mockAuthenticatedShopping } from './fixtures/auth';
import ruApi from '../../src/i18n/messages/ru/api.json';
import enApi from '../../src/i18n/messages/en/api.json';

for (const locale of ['ru', 'en'] as const) {
  test(`text import overload stays inline and can be retried (${locale}) @smoke`, async ({
    page,
  }) => {
    const state = await mockAuthenticatedShopping(page, [createShoppingItem('seed-item')]);
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: locale, domain: 'localhost', path: '/' }]);
    const message = (locale === 'ru' ? ruApi : enApi).aiText.unavailable;
    const requests: unknown[] = [];
    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    // Browser contract only: server retry/quota behavior is covered with the real route in Vitest.
    await page.route('**/api/lists/import-text', async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        await route.fulfill({
          status: 503,
          headers: { 'Retry-After': '60' },
          json: { error: message },
        });
      } else {
        state.items.push(createShoppingItem('imported-item'));
        await route.fulfill({
          status: 200,
          json: {
            results: {
              added: [{ name: 'Milk', category: 'Dairy' }],
              created: [],
              skipped: [],
              failed: [],
            },
          },
        });
      }
    });
    await page.goto(`/lists/${E2E_LIST_ID}`);
    await page
      .getByRole('button', { name: locale === 'ru' ? 'Импорт из текста' : 'Import from text' })
      .click();
    const input = page.getByRole('textbox', {
      name: locale === 'ru' ? 'Вставьте список покупок' : 'Paste your shopping list',
    });
    const text = 'Milk 2L\nGarlic';
    await input.fill(text);
    const submit = page.getByRole('button', {
      name: locale === 'ru' ? 'Импортировать' : 'Import',
      exact: true,
    });
    await submit.click();
    await expect(page.getByRole('alert')).toHaveText(message);
    await expect(input).toHaveValue(text);
    await expect(submit).toBeEnabled();
    expect(dialogs).toEqual([]);
    await submit.click();
    await expect(
      page.getByText(locale === 'ru' ? 'Импорт завершён!' : 'Import complete!', { exact: true })
    ).toBeVisible();
    expect(requests).toEqual([
      { listId: E2E_LIST_ID, text },
      { listId: E2E_LIST_ID, text },
    ]);
    expect(state.items).toHaveLength(2);
    expect(dialogs).toEqual([]);
  });
}
