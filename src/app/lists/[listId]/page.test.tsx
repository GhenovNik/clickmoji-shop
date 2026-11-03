import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '@/test/intl';

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
  const view = renderWithIntl(
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<p>loading</p>}>
        <ShoppingListPage params={params} />
      </Suspense>
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
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

describe('compact shopping presentation', () => {
  const getList = () => screen.getByRole('button', { name: 'Список' });
  const getGrid = () => screen.getByRole('button', { name: 'Плитка' });
  const getCategory = () => screen.getByRole('button', { name: /^🥛 Молочное \(1\)/ });

  it('defaults to list, collapses categories and remembers both choices after remount', async () => {
    serverItems = [milk];
    const first = renderPage();
    await screen.findByText('Молоко');
    expect(getList()).toHaveAttribute('aria-pressed', 'true');
    expect(getGrid()).toHaveAttribute('aria-pressed', 'false');
    expect(getCategory()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(getGrid());
    fireEvent.click(getCategory());
    expect(getGrid()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Молоко')).not.toBeInTheDocument();
    first.unmount();
    first.queryClient.clear();
    renderPage();
    await screen.findByRole('button', { name: /^🥛 Молочное \(1\)/ });
    expect(getGrid()).toHaveAttribute('aria-pressed', 'true');
    expect(getCategory()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(getCategory());
    expect(screen.getByText('Молоко')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Куплено: Молоко' })).toHaveLength(1);
  });

  it('collapses Purchased independently from its category and pending categories', async () => {
    serverItems = [milk, { ...milk, id: 'item-2', isPurchased: true }];
    renderPage();
    const purchased = await screen.findByRole('button', { name: 'Куплено (1)' });
    const toBuy = screen.getByRole('region', { name: 'Купить' });
    fireEvent.click(within(toBuy).getByRole('button', { name: /^🥛 Молочное \(1\)/ }));
    expect(screen.getAllByRole('button', { name: 'Куплено: Молоко' })).toHaveLength(1);
    fireEvent.click(purchased);
    expect(purchased).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Куплено: Молоко' })).not.toBeInTheDocument();
    fireEvent.click(purchased);
    expect(screen.getByRole('button', { name: 'Куплено: Молоко' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(toBuy).getByRole('button', { name: /^🥛 Молочное \(1\)/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it.each(['{invalid json', 'null', '[]', '{"view":"unknown","collapsed":null}'])(
    'ignores malformed saved preferences: %s',
    async (saved) => {
      vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(saved);
      serverItems = [milk];
      renderPage();
      await screen.findByText('Молоко');
      expect(getList()).toHaveAttribute('aria-pressed', 'true');
      expect(getCategory()).toHaveAttribute('aria-expanded', 'true');
    }
  );

  it('works when reading and writing localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    serverItems = [milk];
    renderPage();
    await screen.findByText('Молоко');
    expect(getList()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(getGrid());
    fireEvent.click(getCategory());
    expect(getGrid()).toHaveAttribute('aria-pressed', 'true');
    expect(getCategory()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe.each(['list', 'grid'])('purchase focus in %s view', (view) => {
  for (const initiallyPurchased of [false, true]) {
    describe(`purchase focus (initially purchased: ${initiallyPurchased})`, () => {
      for (const outcome of ['success', '503', 'abort'] as const) {
        it.each([false, true])(`${outcome}, user moved focus: %s`, async (moveFocus) => {
          serverItems = [{ ...milk, isPurchased: initiallyPurchased }];
          let resolvePut!: (response: Response) => void;
          let rejectPut!: (error: Error) => void;
          const heldPut = new Promise<Response>((resolve, reject) => {
            resolvePut = resolve;
            rejectPut = reject;
          });
          vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: RequestInit) => {
              if (init?.method === 'PUT' && url === '/api/lists/list-1/items/item-1')
                return heldPut;
              if (!init?.method && url === '/api/lists/list-1') {
                listRequests += 1;
                return Promise.resolve(
                  Response.json({ id: 'list-1', name: 'Покупки', items: serverItems })
                );
              }
              throw new Error(`Unexpected fetch: ${url}`);
            })
          );
          const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
          const { queryClient } = renderPage();
          const original = await screen.findByRole('button', { name: 'Куплено: Молоко' });
          if (view === 'grid') fireEvent.click(screen.getByRole('button', { name: 'Плитка' }));
          const getToggle = () => screen.getByRole('button', { name: 'Куплено: Молоко' });
          original.focus();
          fireEvent.click(original);
          await waitFor(() =>
            expect(getToggle()).toHaveAttribute('aria-pressed', String(!initiallyPurchased))
          );
          // The real page and hook have committed the optimistic move, but PUT is still held.
          expect(queryClient.isMutating()).toBe(1);
          expect(getToggle()).not.toBe(original);
          expect(getToggle()).toHaveFocus();
          const neighbour = screen.getByRole('button', { name: /Импорт из текста/ });
          if (moveFocus) neighbour.focus();
          const readsBeforeResponse = listRequests;
          await act(async () => {
            if (outcome === 'success') {
              serverItems = [{ ...milk, isPurchased: !initiallyPurchased }];
              resolvePut(Response.json(serverItems[0]));
            } else if (outcome === '503') {
              resolvePut(Response.json({}, { status: 503 }));
            } else {
              rejectPut(new DOMException('Request aborted', 'AbortError'));
            }
            await heldPut.catch(() => undefined);
          });
          await waitFor(() => expect(queryClient.isMutating()).toBe(0));
          await waitFor(() => expect(listRequests).toBeGreaterThan(readsBeforeResponse));
          const expected = outcome === 'success' ? !initiallyPurchased : initiallyPurchased;
          await waitFor(() =>
            expect(getToggle()).toHaveAttribute('aria-pressed', String(expected))
          );
          expect(moveFocus ? neighbour : getToggle()).toHaveFocus();
          if (outcome !== 'success') expect(consoleError).toHaveBeenCalled();
          queryClient.clear();
        });
      }
    });
  }
});
