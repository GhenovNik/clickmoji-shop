import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// After import, complete and restore the React Query cache must agree with the server: each
// operation invalidates exactly the entities it changed, and nothing else.

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-b' } }, status: 'authenticated' }),
}));

const { default: ImportListModal } = await import('@/components/shopping/ImportListModal');
const { useShoppingListItems } = await import('@/hooks/useShoppingListItems');
const { default: HistoryPage } = await import('@/app/history/page');

type Route = { method?: string; url: string; status?: number; body: unknown };

function mockFetch(routes: Route[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const route = routes.find((r) => r.url === url && (r.method ?? 'GET') === method);
      if (!route) throw new Error(`unexpected fetch ${method} ${url}`);
      return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
    })
  );
}

let queryClient: QueryClient;
let invalidated: string[];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const keys = (...queryKeys: unknown[][]) => queryKeys.map((key) => JSON.stringify(key)).sort();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  router.push.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: false } },
  });
  invalidated = [];
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  vi.spyOn(queryClient, 'invalidateQueries').mockImplementation((filters, options) => {
    invalidated.push(JSON.stringify(filters?.queryKey));
    return invalidate(filters, options);
  });
});

const importResults = (created: number) => ({
  results: {
    added: [{ name: 'Молоко', category: 'Молочное' }],
    created: Array.from({ length: created }, () => ({ name: 'Тархун', category: 'Напитки' })),
    skipped: [],
    failed: [],
  },
});

async function submitImport() {
  render(<ImportListModal listId="list-1" isOpen onClose={vi.fn()} />, { wrapper });
  fireEvent.change(screen.getByLabelText('Вставьте список покупок'), {
    target: { value: 'молоко, тархун' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Импортировать/ }));
  await screen.findByText('Импорт завершён!');
}

describe('import from text', () => {
  it('invalidates the list, the list counts and the catalog when products were created', async () => {
    mockFetch([{ method: 'POST', url: '/api/lists/import-text', body: importResults(1) }]);

    await submitImport();

    await waitFor(() =>
      expect(invalidated.sort()).toEqual(
        keys(['list', 'list-1'], ['lists'], ['products'], ['search'], ['categories'])
      )
    );
  });

  it('leaves the catalog alone when no product was created', async () => {
    mockFetch([{ method: 'POST', url: '/api/lists/import-text', body: importResults(0) }]);

    await submitImport();

    await waitFor(() => expect(invalidated.sort()).toEqual(keys(['list', 'list-1'], ['lists'])));
  });
});

describe('complete a list', () => {
  const list = {
    id: 'list-1',
    name: 'Покупки',
    items: [
      {
        id: 'item-1',
        isPurchased: true,
        product: {
          id: 'milk',
          name: 'Молоко',
          emoji: '🥛',
          isCustom: false,
          imageUrl: null,
          category: { name: 'Молочное', emoji: '🥛', order: 1 },
        },
      },
    ],
  };

  async function renderList() {
    const { result } = renderHook(() => useShoppingListItems('list-1'), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    return result;
  }

  it('invalidates the list, the list counts and the history', async () => {
    mockFetch([
      { url: '/api/lists/list-1', body: list },
      { method: 'POST', url: '/api/history', body: { id: 'history-1', items: [] } },
    ]);
    const result = await renderList();

    await act(() => result.current.completeList());

    expect(invalidated.sort()).toEqual(keys(['history'], ['list', 'list-1'], ['lists']));
    expect(router.push).toHaveBeenCalledWith('/history');
  });

  it('invalidates nothing when the server refuses', async () => {
    mockFetch([
      { url: '/api/lists/list-1', body: list },
      { method: 'POST', url: '/api/history', status: 500, body: { error: 'x' } },
    ]);
    const result = await renderList();

    await act(() => result.current.completeList());

    expect(invalidated).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('restore from history', () => {
  it('invalidates the lists and opens the new list', async () => {
    mockFetch([
      {
        url: '/api/history',
        body: [
          {
            id: 'history-1',
            listName: 'Покупки',
            completedAt: '2026-10-01T10:00:00.000Z',
            items: [],
          },
        ],
      },
      {
        method: 'POST',
        url: '/api/history/history-1/restore',
        body: { listId: 'list-new', createdCount: 1, skippedCount: 0 },
      },
    ]);
    render(<HistoryPage />, { wrapper });

    fireEvent.click(await screen.findByText(/2026/));
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить в новый список' }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/lists/list-new'));
    expect(invalidated).toEqual(keys(['lists']));
  });
});
