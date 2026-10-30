import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// What the shopper sees after "import list from text": the open list (React Query, staleTime five
// minutes as in QueryProvider) must show the imported items once the server has added them,
// without a page reload. The server is a fetch fake that really adds the items.

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const { default: ImportListModal } = await import('@/components/shopping/ImportListModal');
const { useShoppingListItems } = await import('@/hooks/useShoppingListItems');

const milk = {
  id: 'milk',
  name: 'Молоко',
  emoji: '🥛',
  isCustom: false,
  imageUrl: null,
  category: { name: 'Молочное', emoji: '🥛', order: 1 },
};

function ListWithImport() {
  const { items, loading } = useShoppingListItems('list-1');
  if (loading) return <p>loading</p>;
  return (
    <>
      <ul aria-label="items">
        {items.map((item) => (
          <li key={item.id}>{item.product.name}</li>
        ))}
      </ul>
      <ImportListModal listId="list-1" isOpen onClose={vi.fn()} />
    </>
  );
}

beforeEach(() => {
  const server = { items: [] as Array<{ id: string; isPurchased: boolean; product: typeof milk }> };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/lists/list-1' && !init?.method) {
        return Response.json({ id: 'list-1', name: 'Покупки', items: server.items });
      }
      if (url === '/api/lists/import-text' && init?.method === 'POST') {
        server.items.push({ id: 'item-1', isPurchased: false, product: milk });
        return Response.json({
          results: {
            added: [{ name: 'Молоко', category: 'Молочное' }],
            created: [],
            skipped: [],
            failed: [],
          },
        });
      }
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
    })
  );
});

describe('import list from text, as the shopper sees it', () => {
  it('shows the imported product in the open list without a reload', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ListWithImport />
      </QueryClientProvider>
    );
    const list = await screen.findByRole('list', { name: 'items' });
    expect(list.textContent).toBe('');

    fireEvent.change(screen.getByLabelText('Вставьте список покупок'), {
      target: { value: 'Молоко' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Импортировать/ }));
    await screen.findByText('Импорт завершён!');

    await waitFor(() => expect(list.textContent).toContain('Молоко'), { timeout: 1500 });
  });
});

describe('import result report', () => {
  it('still renders when a failed entry carries a non-string product name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          results: {
            added: [{ name: 'Молоко', category: 'Молочное' }],
            created: [],
            skipped: [],
            failed: [{ product: { nameRu: { text: 'Сыр' } }, reason: 'Unrecognized entry' }],
          },
        })
      )
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ImportListModal listId="list-1" isOpen onClose={vi.fn()} />
      </QueryClientProvider>
    );

    fireEvent.change(screen.getByLabelText('Вставьте список покупок'), {
      target: { value: 'Молоко, сыр' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Импортировать/ }));

    expect(await screen.findByText('Импорт завершён!')).toBeTruthy();
    expect(screen.getByText(/Unknown: Unrecognized entry/)).toBeTruthy();
  });
});
