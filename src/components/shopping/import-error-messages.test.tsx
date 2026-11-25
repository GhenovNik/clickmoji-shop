import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test/intl';
import { messages } from '@/i18n/messages';
import { LOCALIZED_API_ERROR_HEADER, LOCALIZED_API_ERROR_VALUE } from '@/lib/api-error-source';
import ImportListModal from './ImportListModal';

// The import window shows one message for every failed request. An error text is shown as written
// only when the app marked its response as its own (LOCALIZED_API_ERROR_HEADER, set by the route
// for every error it returns); a gateway's JSON error, a network failure, a body that is not JSON
// or an unknown body becomes the generic localized message. A success report is checked before it
// renders: a malformed entry never crashes the window.

const LIST_TEXT = 'Milk';
const NETWORK_RU = messages.ru.lists.importMutation.network;
const NETWORK_EN = messages.en.lists.importMutation.network;
const FAILED_RU = messages.ru.lists.importMutation.failed;
const FAILED_EN = messages.en.lists.importMutation.failed;

// A response exactly as the import route sends an error it produced itself.
function localizedError(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      [LOCALIZED_API_ERROR_HEADER]: LOCALIZED_API_ERROR_VALUE,
    },
  });
}

// A success report as the route sends it, with the given entries.
function reportResponse(results: Record<string, unknown>) {
  return Response.json(
    { message: 'ok', results: { added: [], created: [], skipped: [], failed: [], ...results } },
    { status: 200 }
  );
}

function renderModal(locale: 'ru' | 'en') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  renderWithIntl(
    <QueryClientProvider client={client}>
      <ImportListModal listId="list-1" isOpen onClose={vi.fn()} />
    </QueryClientProvider>,
    { locale }
  );
}

async function submitText(text: string) {
  const field = screen.getByRole('textbox');
  fireEvent.change(field, { target: { value: text } });
  await act(async () => {
    fireEvent.submit(field.closest('form')!);
    await vi.advanceTimersByTimeAsync(10);
  });
}

function alertText() {
  return screen.getByRole('alert').textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  { locale: 'ru' as const, network: NETWORK_RU, failed: FAILED_RU },
  { locale: 'en' as const, network: NETWORK_EN, failed: FAILED_EN },
])('import errors in $locale', ({ locale, network, failed }) => {
  it('shows the localized message when the request never reaches the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    renderModal(locale);
    await submitText(LIST_TEXT);
    expect(alertText()).toBe(network);
    expect(alertText()).not.toContain('Failed to fetch');
  });

  it('shows the localized message for a 200 response whose body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>gateway</html>', { status: 200 }))
    );
    renderModal(locale);
    await submitText(LIST_TEXT);
    expect(alertText()).toBe(failed);
    expect(alertText()).not.toMatch(/JSON|Unexpected token/);
  });

  it('shows the localized message for an error response whose body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad Gateway', { status: 502 }))
    );
    renderModal(locale);
    await submitText(LIST_TEXT);
    expect(alertText()).toBe(failed);
  });

  it('shows the localized message for a 502 JSON gateway error without the app marker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'Bad Gateway' }, { status: 502 }))
    );
    renderModal(locale);
    await submitText(LIST_TEXT);
    expect(alertText()).toBe(failed);
    expect(alertText()).not.toContain('Bad Gateway');
  });

  it('shows the localized message for a JSON body without a results report', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ unexpected: true }, { status: 200 }))
    );
    renderModal(locale);
    await submitText(LIST_TEXT);
    expect(alertText()).toBe(failed);
  });

  it('shows the API error text, already in the request language, for a known error', async () => {
    const apiText = messages[locale].api.import.listNotFound;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => localizedError({ error: apiText }, 404))
    );
    renderModal(locale);
    await submitText(LIST_TEXT);
    expect(alertText()).toBe(apiText);
  });

  it('keeps the text-length limit message from the API without regression', async () => {
    const limitText = messages[locale].api.import.textTooLong.replace('{max}', '5000');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => localizedError({ error: limitText }, 400))
    );
    renderModal(locale);
    await submitText('x'.repeat(10));
    expect(alertText()).toBe(limitText);
  });

  it('shows the rate-limit (429) and payload-size (413) texts from the app', async () => {
    for (const [status, text] of [
      [429, messages[locale].api.rateLimited],
      [413, messages[locale].api.import.payloadTooLarge],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => localizedError({ error: text }, status))
      );
      renderModal(locale);
      await submitText(LIST_TEXT);
      expect(alertText()).toBe(text);
      cleanup();
    }
  });

  it('shows a usable report when some entries are valid and others are null or malformed', async () => {
    const unrecognized = messages[locale].lists.importModal.unrecognizedEntry;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reportResponse({
          added: [{ name: 'Молоко', category: 'Молочные продукты' }, null, 'bad'],
          created: [null, { name: 'Сыр', category: 'Молочные продукты' }],
          skipped: [42, { name: 'Хлеб', reason: 'Уже в списке' }],
          failed: [null, { product: null, reason: 'Ошибка' }],
        })
      )
    );
    renderModal(locale);
    await submitText(LIST_TEXT);
    // The valid entries are shown; both failed entries (a null and a product-less one) are kept
    // and named with the fallback, so the failure count is not lost.
    expect(screen.getAllByText(unrecognized, { exact: false })).toHaveLength(2);
    expect(document.body.textContent).toContain('Сыр');
    expect(document.body.textContent).toContain('Хлеб');
  });

  it('keeps a valid partial success visible when nothing failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reportResponse({ added: [{ name: 'Молоко', category: 'Молочные продукты' }] })
      )
    );
    renderModal(locale);
    await submitText(LIST_TEXT);
    expect(screen.getByRole('status').textContent).toContain(
      messages[locale].lists.importModal.doneTitle
    );
    expect(document.body.textContent).toContain(messages[locale].lists.importModal.addedLabel);
  });
});
