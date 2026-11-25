import { act, fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test/intl';
import { messages } from '@/i18n/messages';
import ImportListModal from './ImportListModal';

// The import window shows one message for every failed request. A known, localized API error is
// shown as written; a network failure, a body that is not JSON or an unknown body becomes the
// generic localized message, never the browser's or the JSON parser's own text.

const LIST_TEXT = 'Milk';
const NETWORK_RU = messages.ru.lists.importMutation.network;
const NETWORK_EN = messages.en.lists.importMutation.network;
const FAILED_RU = messages.ru.lists.importMutation.failed;
const FAILED_EN = messages.en.lists.importMutation.failed;

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
      vi.fn(async () => Response.json({ error: apiText }, { status: 404 }))
    );
    renderModal(locale);
    await submitText(LIST_TEXT);
    expect(alertText()).toBe(apiText);
  });

  it('keeps the text-length limit message from the API without regression', async () => {
    const limitText = messages[locale].api.import.textTooLong.replace('{max}', '5000');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: limitText }, { status: 400 }))
    );
    renderModal(locale);
    await submitText('x'.repeat(10));
    expect(alertText()).toBe(limitText);
  });
});
