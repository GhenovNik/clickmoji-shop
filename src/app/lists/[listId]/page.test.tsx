import { Suspense } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The page decides what an empty list offers. Import must be reachable there too, and a finished
// import must turn the empty state into the list of imported items through the same cache path.

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));

const session = vi.hoisted(() => ({
  data: { user: { id: 'user-b' } },
  status: 'authenticated' as const,
}));

vi.mock('next-auth/react', () => ({ useSession: () => session }));

vi.mock('@/components/ProductSearch', () => ({ default: () => null }));

const { default: ShoppingListPage } = await import('@/app/lists/[listId]/page');

type Item = {
  id: string;
  isPurchased: boolean;
  product: {
    id: string;
    name: string;
    emoji: string;
    isCustom: boolean;
    imageUrl: null;
    category: { name: string; emoji: string; order: number };
  };
};

const milk: Item = {
  id: 'item-1',
  isPurchased: false,
  product: {
    id: 'milk',
    name: 'Молоко',
    emoji: '🥛',
    isCustom: false,
    imageUrl: null,
    category: { name: 'Молочное', emoji: '🥛', order: 1 },
  },
};

// React's `use` reads a manually settled thenable without suspending.
const params = Object.assign(Promise.resolve({ listId: 'list-1' }), {
  status: 'fulfilled' as const,
  value: { listId: 'list-1' },
});

let serverItems: Item[];
let listRequests: number;

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<p>loading</p>}>
        <ShoppingListPage params={params} />
      </Suspense>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  serverItems = [];
  listRequests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === '/api/lists/list-1') {
        listRequests += 1;
        return Response.json({ id: 'list-1', name: 'Покупки', items: serverItems });
      }
      if (method === 'POST' && url === '/api/lists/import-text') {
        serverItems = [...serverItems, milk];
        return Response.json({
          results: {
            added: [{ name: 'Молоко', category: 'Молочное' }],
            created: [],
            skipped: [],
            failed: [],
          },
        });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    })
  );
});

describe('an empty list', () => {
  it('offers text import beside adding products and shows the imported items', async () => {
    renderPage();

    expect(await screen.findByText('Покупки пуст')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Импорт из текста/ }));
    const textarea = await screen.findByLabelText('Вставьте список покупок');

    fireEvent.change(textarea, { target: { value: 'Молоко' } });
    fireEvent.click(screen.getByRole('button', { name: /Импортировать/ }));

    expect(await screen.findByText('Импорт завершён!')).toBeTruthy();

    await waitFor(() => expect(screen.getByText('Молоко')).toBeTruthy());
    expect(screen.queryByText('Покупки пуст')).toBeNull();
    expect(listRequests).toBeGreaterThanOrEqual(2);
  });
});

describe('a list with items', () => {
  it('keeps the existing import button and does not refetch before an import', async () => {
    serverItems = [milk];
    renderPage();

    expect(await screen.findByText('Молоко')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Импорт из текста/ }));

    expect(await screen.findByLabelText('Вставьте список покупок')).toBeTruthy();
    expect(listRequests).toBe(1);
  });
});
