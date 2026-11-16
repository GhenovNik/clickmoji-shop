import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
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
  note?: string | null;
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

for (const initiallyPurchased of [false, true]) {
  describe(`purchase focus (initially purchased: ${initiallyPurchased})`, () => {
    for (const outcome of ['success', '503', 'abort'] as const) {
      it.each([false, true])(
        `${outcome}, user moved focus: %s`,
        async (moveFocus) => {
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
          const getToggle = () => screen.getByRole('button', { name: 'Куплено: Молоко' });
          original.focus();
          fireEvent.click(original);
          await waitFor(() =>
            expect(getToggle()).toHaveAttribute('aria-pressed', String(!initiallyPurchased))
          );
          // The real page and hook have committed the optimistic move, but PUT is still held.
          expect(queryClient.isMutating()).toBe(1);
          expect(getToggle()).not.toBe(original);
          // AGE-1649: a disabled control cannot hold focus, so the busy row's toggle is not
          // focused. Focus is not stolen; it returns to the toggle when the row unlocks (below).
          expect(getToggle()).toBeDisabled();
          expect(getToggle()).not.toHaveFocus();
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
          // N1 contract: a retryable PUT failure is retried at 1s/2s/4s before the terminal
          // rollback; waitFor polls the predicate, so the timeout is an upper bound.
          await waitFor(() => expect(queryClient.isMutating()).toBe(0), { timeout: 10000 });
          await waitFor(() => expect(listRequests).toBeGreaterThan(readsBeforeResponse));
          const expected = outcome === 'success' ? !initiallyPurchased : initiallyPurchased;
          await waitFor(() =>
            expect(getToggle()).toHaveAttribute('aria-pressed', String(expected))
          );
          expect(moveFocus ? neighbour : getToggle()).toHaveFocus();
          if (outcome !== 'success') expect(consoleError).toHaveBeenCalled();
          queryClient.clear();
          // The terminal rollback lands after the full retry budget;
          // the test timeout stays above it.
        },
        12000
      );
    }
  });
}

const bread: Item = {
  id: 'item-2',
  isPurchased: false,
  product: {
    id: 'bread',
    name: 'Хлеб',
    emoji: '🍞',
    isCustom: false,
    imageUrl: null,
    category: { name: 'Выпечка', emoji: '🥐', order: 2 },
  },
};

type RowControl = {
  puts: Array<{ url: string; body: unknown }>;
  releasePut: (response: Response) => void;
  holdReload: () => void;
  releaseReload: () => void;
};

// The row's one PUT is held until the test answers it. The list GET is held only once armed,
// so the mount read is never delayed.
function stubRowFetch(): RowControl {
  let answerPut!: (response: Response) => void;
  const heldPut = new Promise<Response>((resolve) => {
    answerPut = resolve;
  });
  let reloadGate: Promise<void> | null = null;
  let openReload!: () => void;
  const control: RowControl = {
    puts: [],
    releasePut: (response) => answerPut(response),
    holdReload: () => {
      reloadGate = new Promise<void>((resolve) => {
        openReload = resolve;
      });
    },
    releaseReload: () => openReload(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url === '/api/lists/list-1/items/item-1') {
        control.puts.push({ url, body: JSON.parse(String(init?.body)) });
        return heldPut;
      }
      if (method === 'GET' && url === '/api/lists/list-1') {
        listRequests += 1;
        if (reloadGate) await reloadGate;
        return Response.json({ id: 'list-1', name: 'Покупки', items: serverItems });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    })
  );
  return control;
}

const notePuts = (control: RowControl) =>
  control.puts.filter(
    (put) => typeof put.body === 'object' && put.body !== null && 'note' in put.body
  );

describe('row lock while a request is in flight (AGE-1649)', () => {
  it('AC-1: while a toggle is in flight its row is busy and its controls are disabled; clear-all is unavailable; a neighbour stays enabled', async () => {
    serverItems = [milk, bread];
    const control = stubRowFetch();
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Куплено: Молоко' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Куплено: Молоко' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    );

    const busyRow = screen.getByRole('button', { name: 'Куплено: Молоко' }).closest('.group');
    expect.soft(busyRow?.getAttribute('aria-busy')).toBe('true');
    expect.soft(screen.getByRole('button', { name: 'Куплено: Молоко' })).toBeDisabled();
    expect.soft(screen.getByRole('button', { name: 'Удалить товар: Молоко' })).toBeDisabled();
    expect.soft(screen.getByRole('button', { name: 'Очистить всё' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Куплено: Хлеб' })).toBeEnabled();

    await act(async () =>
      control.releasePut(new Response('{"isPurchased":true}', { status: 200 }))
    );
  });

  it('AC-5: a note save is one submit; the editor stays open and disabled until the server answers, then closes', async () => {
    serverItems = [milk];
    const control = stubRowFetch();
    renderPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Редактировать комментарий: Молоко' })
    );
    const input = await screen.findByPlaceholderText('Заметка к товару...');
    fireEvent.change(input, { target: { value: 'к ужину' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // While the save is in flight the editor is still open and its input is disabled.
    const editor = screen.queryByPlaceholderText('Заметка к товару...') as HTMLInputElement | null;
    expect.soft(editor?.disabled).toBe(true);

    // The first submit reaches the wire; the mutation dispatches it after its async pre-step.
    await waitFor(() => expect(notePuts(control)).toHaveLength(1));

    // Blur, Enter and the save button cannot start a second note request.
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    const save = screen.queryByRole('button', { name: 'Ок' });
    if (save) fireEvent.click(save);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(notePuts(control)).toHaveLength(1);

    serverItems = [{ ...milk, note: 'к ужину' }];
    await act(async () => control.releasePut(new Response('{}', { status: 200 })));
    await waitFor(() => expect(screen.queryByPlaceholderText('Заметка к товару...')).toBeNull());
    expect(await screen.findByText('к ужину')).toBeTruthy();
  });

  it('AC-5: a failed note save keeps the editor disabled through the reload, then closes it', async () => {
    serverItems = [milk];
    const control = stubRowFetch();
    renderPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Редактировать комментарий: Молоко' })
    );
    const input = await screen.findByPlaceholderText('Заметка к товару...');
    fireEvent.change(input, { target: { value: 'к ужину' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    control.holdReload();
    await act(async () => control.releasePut(new Response('{}', { status: 401 })));
    await waitFor(() => expect(listRequests).toBeGreaterThan(1));

    const editor = screen.queryByPlaceholderText('Заметка к товару...') as HTMLInputElement | null;
    expect.soft(editor?.disabled).toBe(true);

    control.releaseReload();
    await waitFor(() => expect(screen.queryByPlaceholderText('Заметка к товару...')).toBeNull());
  });
});
