import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '@/test/intl';
import HistoryPage from './page';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-b' } }, status: 'authenticated' }),
}));

const completedAt = '2026-10-01T10:00:00.000Z';
let queryClient: QueryClient;
let restoreBody: unknown;

function renderHistory(listName: string | null | undefined, locale: 'ru' | 'en' = 'ru') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/history' && !init?.method) {
        return Response.json([{ id: 'history-b', listName, completedAt, items: [] }]);
      }
      if (url === '/api/history/history-b/restore' && init?.method === 'POST') {
        restoreBody = JSON.parse(String(init.body));
        return Response.json({ listId: 'restored-list', createdCount: 0, skippedCount: 0 });
      }
      throw new Error(`Unexpected request: ${url}`);
    })
  );
  return renderWithIntl(
    <QueryClientProvider client={queryClient}>
      <HistoryPage />
    </QueryClientProvider>,
    { locale }
  );
}

function completionDate(locale: 'ru' | 'en') {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(completedAt));
}

beforeEach(() => {
  router.push.mockReset();
  restoreBody = undefined;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

for (const locale of ['ru', 'en'] as const) {
  describe(`history list names (${locale})`, () => {
    it('shows the original name as the heading alongside the completion date and count', async () => {
      renderHistory('На неделю', locale);

      expect(await screen.findByRole('heading', { name: 'На неделю' })).toBeVisible();
      expect(screen.getByText(completionDate(locale))).toBeVisible();
      expect(screen.getByText(locale === 'ru' ? '0 товаров' : '0 items')).toBeVisible();
    });

    it.each(['', null, undefined, '   '])(
      'uses the completion date for a legacy name %s',
      async (name) => {
        renderHistory(name, locale);

        expect(await screen.findByRole('heading', { name: completionDate(locale) })).toBeVisible();
      }
    );

    it('restores without overriding the saved name with a date-based name', async () => {
      renderHistory('На неделю', locale);
      fireEvent.click(await screen.findByText(completionDate(locale)));
      fireEvent.click(
        screen.getByRole('button', {
          name: locale === 'ru' ? 'Восстановить в новый список' : 'Restore to a new list',
        })
      );

      await waitFor(() => expect(router.push).toHaveBeenCalledWith('/lists/restored-list'));
      expect(restoreBody).toEqual({});
    });

    it('uses a localized fallback only when restoring an unnamed legacy snapshot', async () => {
      renderHistory('', locale);
      fireEvent.click(await screen.findByRole('heading', { name: completionDate(locale) }));
      fireEvent.click(
        screen.getByRole('button', {
          name: locale === 'ru' ? 'Восстановить в новый список' : 'Restore to a new list',
        })
      );

      await waitFor(() => expect(router.push).toHaveBeenCalledWith('/lists/restored-list'));
      expect(restoreBody).toEqual({
        name: `${locale === 'ru' ? 'Список от' : 'List from'} ${completionDate(locale)}`,
      });
    });
  });
}
