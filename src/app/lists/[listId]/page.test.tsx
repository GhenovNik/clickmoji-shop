import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
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

function renderPage(
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: false } },
  })
) {
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

  it('F1 closure: a row arriving while completeList is in flight renders aria-busy with disabled controls until Complete settles', async () => {
    serverItems = [{ ...milk, isPurchased: true }];
    let releasePost!: (response: Response) => void;
    const heldPost = new Promise<Response>((resolve) => {
      releasePost = resolve;
    });
    const puts: string[] = [];
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url === '/api/lists/list-1') {
          listRequests += 1;
          return Response.json({ id: 'list-1', name: 'Покупки', items: serverItems });
        }
        if (method === 'POST' && url === '/api/history') {
          posts += 1;
          return heldPost;
        }
        if (method === 'PUT' && url === '/api/lists/list-1/items/item-2') {
          puts.push(url);
          return Response.json({ ...bread, isPurchased: true });
        }
        throw new Error(`unexpected fetch ${method} ${url}`);
      })
    );
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { queryClient } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Завершить покупку/ }));
    await waitFor(() => expect(posts).toBe(1));

    expect(screen.getByRole('button', { name: /Завершить покупку/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Очистить всё' })).toBeDisabled();

    act(() => {
      queryClient.setQueryData(queryKeys.list('list-1'), {
        id: 'list-1',
        name: 'Покупки',
        items: [...serverItems, bread],
      });
    });

    const breadToggle = await screen.findByRole('button', { name: 'Куплено: Хлеб' });
    const breadRow = breadToggle.closest('.group');
    expect(breadRow?.getAttribute('aria-busy')).toBe('true');
    expect(breadToggle).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Удалить товар: Хлеб' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Редактировать комментарий: Хлеб' })).toBeDisabled();

    await act(async () => {
      releasePost(Response.json({ error: 'boom' }, { status: 500 }));
      await heldPost;
    });

    await waitFor(() => expect(breadToggle).toBeEnabled());
    expect(breadRow?.getAttribute('aria-busy')).toBeNull();

    fireEvent.click(breadToggle);
    await waitFor(() => expect(puts).toEqual(['/api/lists/list-1/items/item-2']));
  });
});

describe('F3/F5 page regressions (AGE-1649)', () => {
  const cheese: Item = {
    id: 'item-3',
    isPurchased: false,
    product: {
      id: 'cheese',
      name: 'Сыр',
      emoji: '🧀',
      isCustom: false,
      imageUrl: null,
      category: { name: 'Молочное', emoji: '🥛', order: 1 },
    },
  };

  it('F3 page: remounting during held toggle PUT preserves aria-busy and disabled controls, keeps neighbour enabled, then unlocks', async () => {
    serverItems = [milk, bread];
    const control = stubRowFetch();
    const firstView = renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Куплено: Молоко' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Куплено: Молоко' })).toBeDisabled()
    );

    firstView.unmount();
    renderPage(firstView.queryClient);

    const milkToggle = await screen.findByRole('button', { name: 'Куплено: Молоко' });
    const milkRow = milkToggle.closest('.group');
    expect(milkRow?.getAttribute('aria-busy')).toBe('true');
    expect(milkToggle).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Удалить товар: Молоко' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Очистить всё' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Куплено: Хлеб' })).toBeEnabled();

    serverItems = [{ ...milk, isPurchased: true }, bread];
    await act(async () =>
      control.releasePut(new Response('{"isPurchased":true}', { status: 200 }))
    );

    await waitFor(() => expect(milkToggle).toBeEnabled());
    expect(milkRow?.getAttribute('aria-busy')).toBeNull();
  });

  it('F3 page: remounting during held Complete POST keeps Complete, Clear all and rows disabled until Complete settles', async () => {
    serverItems = [{ ...milk, isPurchased: true }];
    let releasePost!: (response: Response) => void;
    const heldPost = new Promise<Response>((resolve) => {
      releasePost = resolve;
    });
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url === '/api/lists/list-1') {
          listRequests += 1;
          return Response.json({ id: 'list-1', name: 'Покупки', items: serverItems });
        }
        if (method === 'POST' && url === '/api/history') {
          posts += 1;
          return heldPost;
        }
        throw new Error(`unexpected fetch ${method} ${url}`);
      })
    );
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const firstView = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Завершить покупку/ }));
    await waitFor(() => expect(posts).toBe(1));

    firstView.unmount();
    renderPage(firstView.queryClient);

    const milkToggle = await screen.findByRole('button', { name: 'Куплено: Молоко' });
    expect(milkToggle.closest('.group')?.getAttribute('aria-busy')).toBe('true');
    expect(milkToggle).toBeDisabled();
    expect(screen.getByRole('button', { name: /Завершить покупку/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Очистить всё' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Завершить покупку/ }));
    expect(posts).toBe(1);

    await act(async () => {
      releasePost(Response.json({ error: 'boom' }, { status: 500 }));
      await heldPost;
    });

    await waitFor(() => expect(milkToggle).toBeEnabled());
    expect(screen.getByRole('button', { name: /Завершить покупку/ })).toBeEnabled();
  });

  it('F5 page: keeps confirmed single DELETE, note PUT and partial clear-all visible in UI when follow-up reload GET fails with retry 1', async () => {
    const butter: Item = {
      id: 'item-4',
      isPurchased: false,
      product: {
        id: 'butter',
        name: 'Масло',
        emoji: '🧈',
        isCustom: false,
        imageUrl: null,
        category: { name: 'Молочное', emoji: '🥛', order: 1 },
      },
    };
    serverItems = [milk, bread, cheese, butter];
    let getPhase: 'ok' | 'fail' = 'ok';
    const deletes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url === '/api/lists/list-1') {
          listRequests += 1;
          if (getPhase === 'fail') return Response.json({ error: 'boom' }, { status: 500 });
          return Response.json({ id: 'list-1', name: 'Покупки', items: serverItems });
        }
        if (
          method === 'DELETE' &&
          (url === '/api/lists/list-1/items/item-4' || url === '/api/lists/list-1/items/item-1')
        ) {
          deletes.push(url);
          return Response.json({});
        }
        if (method === 'DELETE' && url === '/api/lists/list-1/items/item-2') {
          deletes.push(url);
          return Response.json({ error: 'boom' }, { status: 500 });
        }
        if (method === 'PUT' && url === '/api/lists/list-1/items/item-2') {
          return Response.json({ ...bread, note: 'на тосты' });
        }
        throw new Error(`unexpected fetch ${method} ${url}`);
      })
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const retryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: 1, retryDelay: 0 } },
    });
    renderPage(retryClient);
    expect(await screen.findByText('Молоко')).toBeTruthy();

    getPhase = 'fail';
    fireEvent.click(screen.getByRole('button', { name: 'Удалить товар: Масло' }));
    await waitFor(() => expect(screen.queryByText('Масло')).toBeNull());
    expect(screen.getByText('Молоко')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Редактировать комментарий: Хлеб' }));
    const input = await screen.findByPlaceholderText('Заметка к товару...');
    fireEvent.change(input, { target: { value: 'на тосты' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByPlaceholderText('Заметка к товару...')).toBeNull());
    expect(await screen.findByText('на тосты')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Очистить всё' }));
    await waitFor(() =>
      expect(deletes).toEqual([
        '/api/lists/list-1/items/item-4',
        '/api/lists/list-1/items/item-1',
        '/api/lists/list-1/items/item-2',
      ])
    );
    await waitFor(() => expect(screen.queryByText('Молоко')).toBeNull());
    expect(screen.getByText('Хлеб')).toBeTruthy();
    expect(screen.getByText('Сыр')).toBeTruthy();
  });
});

describe('F5/F6 page regressions (AGE-1649)', () => {
  const cheese: Item = {
    id: 'item-3',
    isPurchased: false,
    product: {
      id: 'cheese',
      name: 'Сыр',
      emoji: '🧀',
      isCustom: false,
      imageUrl: null,
      category: { name: 'Молочное', emoji: '🥛', order: 1 },
    },
  };

  type QueuedFetch =
    { kind: 'response'; response: () => Response } | { kind: 'gate'; gate: Promise<Response> };

  function stubControlledListFetch() {
    const queues = new Map<string, QueuedFetch[]>();
    const puts: Array<{ url: string; body: unknown }> = [];
    const deletes: string[] = [];
    let getMode: 'ok' | 'fail' = 'ok';

    const routeKey = (method: string, url: string) => `${method} ${url}`;
    const hold = (method: string, url: string) => {
      let release!: (response: Response) => void;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const k = routeKey(method, url);
      queues.set(k, [...(queues.get(k) ?? []), { kind: 'gate', gate }]);
      return release;
    };
    const queueResponse = (method: string, url: string, response: () => Response) => {
      const k = routeKey(method, url);
      queues.set(k, [...(queues.get(k) ?? []), { kind: 'response', response }]);
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && url === '/api/lists/list-1') {
          listRequests += 1;
        } else if (method === 'PUT') {
          puts.push({ url, body: JSON.parse(String(init?.body)) });
        } else if (method === 'DELETE') {
          deletes.push(url);
        }

        const next = queues.get(routeKey(method, url))?.shift();
        if (next?.kind === 'gate') return next.gate;
        if (next?.kind === 'response') return next.response();
        if (method === 'GET' && url === '/api/lists/list-1') {
          if (getMode === 'fail') return Response.json({ error: 'boom' }, { status: 500 });
          return Response.json({ id: 'list-1', name: 'Покупки', items: serverItems });
        }
        throw new Error(`unexpected fetch ${method} ${url}`);
      })
    );

    return {
      puts,
      deletes,
      hold,
      queueResponse,
      setGetMode: (mode: 'ok' | 'fail') => {
        getMode = mode;
      },
    };
  }

  const makeRetryOneClient = () =>
    new QueryClient({
      defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: 1, retryDelay: 0 } },
    });

  it('F5 exact CODE r3 page: DELETE A 200 -> old GET [A,B,C] settles -> DELETE B 500 -> two failed final GETs keep [B,C] in cache and UI and unlock', async () => {
    serverItems = [milk, bread, cheese];
    const control = stubControlledListFetch();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const retryClient = makeRetryOneClient();
    renderPage(retryClient);
    expect(await screen.findByText('Молоко')).toBeTruthy();
    expect(listRequests).toBe(1);

    const releaseOldGet = control.hold('GET', '/api/lists/list-1');
    act(() => {
      void retryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    });
    await waitFor(() => expect(listRequests).toBe(2));

    control.queueResponse('DELETE', '/api/lists/list-1/items/item-1', () => Response.json({}));
    const releaseDeleteB = control.hold('DELETE', '/api/lists/list-1/items/item-2');

    fireEvent.click(screen.getByRole('button', { name: 'Очистить всё' }));
    await waitFor(() =>
      expect(control.deletes).toEqual([
        '/api/lists/list-1/items/item-1',
        '/api/lists/list-1/items/item-2',
      ])
    );
    await waitFor(() => expect(screen.queryByText('Молоко')).toBeNull());
    expect(screen.getByRole('button', { name: 'Очистить всё' })).toBeDisabled();

    // Old GET finishes with [A,B,C] while DELETE B is still held; query returns to idle.
    await act(async () => {
      releaseOldGet(Response.json({ id: 'list-1', name: 'Покупки', items: [milk, bread, cheese] }));
    });
    await waitFor(() =>
      expect(
        retryClient.getQueryCache().find({ queryKey: queryKeys.list('list-1') })?.state.fetchStatus
      ).toBe('idle')
    );

    control.setGetMode('fail');
    await act(async () => {
      releaseDeleteB(Response.json({ error: 'boom' }, { status: 500 }));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Не удалось обновить список'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Очистить всё' })).toBeEnabled());

    expect(control.deletes).toEqual([
      '/api/lists/list-1/items/item-1',
      '/api/lists/list-1/items/item-2',
    ]);
    expect(listRequests).toBe(4);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const cached = retryClient.getQueryData<{ items: Item[] }>(queryKeys.list('list-1'));
    expect(cached?.items.map((item) => item.id)).toEqual(['item-2', 'item-3']);
    expect(screen.queryByText('Молоко')).toBeNull();
    expect(screen.getByText('Хлеб')).toBeTruthy();
    expect(screen.getByText('Сыр')).toBeTruthy();
    const breadToggle = screen.getByRole('button', { name: 'Куплено: Хлеб' });
    expect(breadToggle).toBeEnabled();
    expect(breadToggle.closest('.group')?.getAttribute('aria-busy')).toBeNull();
  });

  it('F6 exact CODE r3 page: old GET returns false before PUT 204, then two failed fresh GETs keep true in cache and aria-pressed="true" and unlock', async () => {
    serverItems = [milk, bread];
    const control = stubControlledListFetch();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    const retryClient = makeRetryOneClient();
    renderPage(retryClient);
    expect(await screen.findByRole('button', { name: 'Куплено: Молоко' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    const releaseOldGet = control.hold('GET', '/api/lists/list-1');
    act(() => {
      void retryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    });
    await waitFor(() => expect(listRequests).toBe(2));

    const releasePut = control.hold('PUT', '/api/lists/list-1/items/item-1');
    fireEvent.click(screen.getByRole('button', { name: 'Куплено: Молоко' }));
    await waitFor(() => expect(control.puts).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Куплено: Молоко' })).toBeDisabled()
    );

    await act(async () => {
      releaseOldGet(Response.json({ id: 'list-1', name: 'Покупки', items: [milk, bread] }));
    });
    await waitFor(() =>
      expect(
        retryClient.getQueryCache().find({ queryKey: queryKeys.list('list-1') })?.state.fetchStatus
      ).toBe('idle')
    );

    control.setGetMode('fail');
    await act(async () => {
      releasePut(new Response(null, { status: 204 }));
    });

    await waitFor(() => expect(listRequests).toBe(4));
    const milkToggle = screen.getByRole('button', { name: 'Куплено: Молоко' });
    await waitFor(() => expect(milkToggle).toBeEnabled());

    expect(control.puts).toEqual([
      { url: '/api/lists/list-1/items/item-1', body: { isPurchased: true } },
    ]);
    const cached = retryClient.getQueryData<{ items: Item[] }>(queryKeys.list('list-1'));
    expect(cached?.items.find((item) => item.id === 'item-1')?.isPurchased).toBe(true);
    expect(milkToggle).toHaveAttribute('aria-pressed', 'true');
    expect(milkToggle.closest('.group')?.getAttribute('aria-busy')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('F6 page ACK before held old GET: PUT 204 before old GET returns false, then two failed fresh GETs keep aria-pressed="true" and unlock', async () => {
    serverItems = [milk, bread];
    const control = stubControlledListFetch();

    const retryClient = makeRetryOneClient();
    renderPage(retryClient);
    expect(await screen.findByRole('button', { name: 'Куплено: Молоко' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    const releaseOldGet = control.hold('GET', '/api/lists/list-1');
    act(() => {
      void retryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    });
    await waitFor(() => expect(listRequests).toBe(2));

    const releasePut = control.hold('PUT', '/api/lists/list-1/items/item-1');
    fireEvent.click(screen.getByRole('button', { name: 'Куплено: Молоко' }));
    await waitFor(() => expect(control.puts).toHaveLength(1));

    await act(async () => {
      releasePut(new Response(null, { status: 204 }));
    });
    expect(listRequests).toBe(2);
    expect(screen.getByRole('button', { name: 'Куплено: Молоко' })).toBeDisabled();

    control.setGetMode('fail');
    await act(async () => {
      releaseOldGet(Response.json({ id: 'list-1', name: 'Покупки', items: [milk, bread] }));
    });

    await waitFor(() => expect(listRequests).toBe(4));
    const milkToggle = screen.getByRole('button', { name: 'Куплено: Молоко' });
    await waitFor(() => expect(milkToggle).toBeEnabled());

    const cached = retryClient.getQueryData<{ items: Item[] }>(queryKeys.list('list-1'));
    expect(cached?.items.find((item) => item.id === 'item-1')?.isPurchased).toBe(true);
    expect(milkToggle).toHaveAttribute('aria-pressed', 'true');
    expect(milkToggle.closest('.group')?.getAttribute('aria-busy')).toBeNull();
  });

  it('F6 page successful fresh GET: old GET returns false before PUT 204, then successful fresh GET updates UI from server', async () => {
    serverItems = [milk, bread];
    const control = stubControlledListFetch();

    const retryClient = makeRetryOneClient();
    renderPage(retryClient);
    expect(await screen.findByRole('button', { name: 'Куплено: Молоко' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    const releaseOldGet = control.hold('GET', '/api/lists/list-1');
    act(() => {
      void retryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    });
    await waitFor(() => expect(listRequests).toBe(2));

    const releasePut = control.hold('PUT', '/api/lists/list-1/items/item-1');
    fireEvent.click(screen.getByRole('button', { name: 'Куплено: Молоко' }));
    await waitFor(() => expect(control.puts).toHaveLength(1));

    await act(async () => {
      releaseOldGet(Response.json({ id: 'list-1', name: 'Покупки', items: [milk, bread] }));
    });
    await waitFor(() =>
      expect(
        retryClient.getQueryCache().find({ queryKey: queryKeys.list('list-1') })?.state.fetchStatus
      ).toBe('idle')
    );

    serverItems = [{ ...milk, isPurchased: true, note: 'серверная заметка' }, bread];
    await act(async () => {
      releasePut(new Response(null, { status: 204 }));
    });

    await waitFor(() => expect(listRequests).toBe(3));
    expect(await screen.findByText('серверная заметка')).toBeTruthy();
    const milkToggle = screen.getByRole('button', { name: 'Куплено: Молоко' });
    await waitFor(() => expect(milkToggle).toBeEnabled());
    expect(milkToggle).toHaveAttribute('aria-pressed', 'true');
    expect(control.puts).toHaveLength(1);
  });
});

type JournalHit = { method: string; url: string; status?: number; body?: unknown };

function stubControlledFetch() {
  const queues = new Map<
    string,
    Array<
      { kind: 'response'; response: () => Response } | { kind: 'gate'; gate: Promise<Response> }
    >
  >();
  const hits: JournalHit[] = [];
  const settled: JournalHit[] = [];
  const routeKey = (method: string, url: string) => `${method} ${url}`;

  const hold = (method: string, url: string) => {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    queues.set(routeKey(method, url), [
      ...(queues.get(routeKey(method, url)) ?? []),
      { kind: 'gate', gate },
    ]);
    return release;
  };

  const queueResponse = (method: string, url: string, response: () => Response) => {
    queues.set(routeKey(method, url), [
      ...(queues.get(routeKey(method, url)) ?? []),
      { kind: 'response', response },
    ]);
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const hit: JournalHit = { method, url };
      if (init?.body) hit.body = JSON.parse(String(init.body));
      hits.push(hit);

      const next = queues.get(routeKey(method, url))?.shift();
      let response: Response;
      if (next?.kind === 'gate') {
        response = await next.gate;
      } else if (next?.kind === 'response') {
        response = next.response();
      } else {
        throw new Error(`unexpected fetch ${method} ${url}`);
      }
      hit.status = response.status;
      settled.push({ ...hit });
      return response;
    })
  );

  return { hits, settled, hold, queueResponse };
}

const makeProductionRetryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });

describe('F7 malformed list GET page regressions (AGE-1649)', () => {
  const stubF7Fetch = stubControlledFetch;

  const makeRetryOneClient = () =>
    new QueryClient({
      defaultOptions: {
        queries: { staleTime: 5 * 60 * 1000, retry: 1, retryDelay: 0, refetchOnWindowFocus: false },
      },
    });

  async function runImportModal(text = 'Сыр') {
    fireEvent.click(screen.getByRole('button', { name: /Импорт из текста/ }));
    fireEvent.change(await screen.findByLabelText('Вставьте список покупок'), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole('button', { name: /Импортировать/ }));
    await screen.findByText('Импорт завершён!');
    fireEvent.click(screen.getAllByRole('button', { name: /^Закрыть$/ })[0]!);
  }

  it('F7 mounted page: rejects malformed old GET 200 {items:null}, retries old cycle before PUT 204, keeps A=true and aria-pressed="true" after two 500 final GETs, and unlocks', async () => {
    const listUrl = '/api/lists/list-1';
    const putUrl = '/api/lists/list-1/items/item-1';
    const importUrl = '/api/lists/import-text';
    const control = stubF7Fetch();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    control.queueResponse('GET', listUrl, () =>
      Response.json({ id: 'list-1', name: 'Покупки', items: [milk] })
    );
    control.queueResponse('POST', importUrl, () =>
      Response.json({
        results: {
          added: [{ name: 'Сыр', category: 'Молочное' }],
          created: [],
          skipped: [],
          failed: [],
        },
      })
    );
    const releaseOldGet1 = control.hold('GET', listUrl);
    const releaseOldGetRetry = control.hold('GET', listUrl);
    const releasePut = control.hold('PUT', putUrl);
    const releaseFinal1 = control.hold('GET', listUrl);
    const releaseFinal2 = control.hold('GET', listUrl);

    const retryClient = makeRetryOneClient();
    renderPage(retryClient);

    const toggle = () => screen.queryByRole('button', { name: 'Куплено: Молоко' });
    const query = () =>
      retryClient.getQueryCache().find({ queryKey: queryKeys.list('list-1'), exact: true });
    const cached = () =>
      retryClient
        .getQueryData<{ items?: Array<{ id: string; isPurchased: boolean }> }>(
          queryKeys.list('list-1')
        )
        ?.items?.map(({ id, isPurchased }) => [id, isPurchased]) ?? null;

    expect(await screen.findByText('Молоко')).toBeTruthy();
    await runImportModal('Сыр');
    await waitFor(() => expect(control.hits.filter((hit) => hit.method === 'GET')).toHaveLength(2));

    fireEvent.click(toggle()!);
    await waitFor(() =>
      expect(control.hits.at(-1)).toMatchObject({
        method: 'PUT',
        url: putUrl,
        body: { isPurchased: true },
      })
    );
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(toggle()).toBeDisabled();

    // Old GET attempt 1 returns 200 {items:null}; must be rejected before cache and trigger retry:1 while PUT is still held.
    await act(async () => {
      releaseOldGet1(Response.json({ id: 'list-1', name: 'Покупки', items: null }));
    });
    await waitFor(() => expect(control.hits.filter((hit) => hit.method === 'GET')).toHaveLength(3));
    expect(cached()).toEqual([['item-1', true]]);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(toggle()).toBeDisabled();

    // Finish old GET retry before PUT 204 ACK arrives so the old cycle settles idle prior to ACK.
    await act(async () => {
      releaseOldGetRetry(Response.json({ error: 'boom' }, { status: 500 }));
    });
    await waitFor(() => expect(query()?.state.fetchStatus).toBe('idle'));
    expect(cached()).toEqual([['item-1', true]]);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(toggle()).toBeDisabled();

    // Now PUT 204 arrives and triggers the distinct final GET cycle (two 500 attempts).
    await act(async () => {
      releasePut(new Response(null, { status: 204 }));
    });
    await waitFor(() => expect(control.hits.filter((hit) => hit.method === 'GET')).toHaveLength(4));
    expect(toggle()).toBeDisabled();

    await act(async () => {
      releaseFinal1(Response.json({ error: 'boom' }, { status: 500 }));
    });
    await waitFor(() => expect(control.hits.filter((hit) => hit.method === 'GET')).toHaveLength(5));
    expect(toggle()).toBeDisabled();

    await act(async () => {
      releaseFinal2(Response.json({ error: 'boom' }, { status: 500 }));
    });
    await waitFor(() => expect(query()?.state.fetchStatus).toBe('idle'));
    await waitFor(() => expect(toggle()).toBeEnabled());

    expect(cached()).toEqual([['item-1', true]]);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(toggle()?.closest('.group')).not.toHaveAttribute('aria-busy');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.filter(([message]) => message === 'List item action failed:')
    ).toEqual([]);
    expect(control.hits.map(({ method, url, status }) => [method, url, status])).toEqual([
      ['GET', listUrl, 200],
      ['POST', importUrl, 200],
      ['GET', listUrl, 200],
      ['PUT', putUrl, 204],
      ['GET', listUrl, 500],
      ['GET', listUrl, 500],
      ['GET', listUrl, 500],
    ]);
    expect(control.settled.map(({ method, url, status }) => [method, url, status])).toEqual([
      ['GET', listUrl, 200],
      ['POST', importUrl, 200],
      ['GET', listUrl, 200],
      ['GET', listUrl, 500],
      ['PUT', putUrl, 204],
      ['GET', listUrl, 500],
      ['GET', listUrl, 500],
    ]);
    expect(control.hits.filter((hit) => hit.method === 'PUT').map((hit) => hit.body)).toEqual([
      { isPurchased: true },
    ]);
  });

  it('F7 mounted page: when malformed old GET retry returns valid stale false before PUT 204, ACK patch still preserves A=true and aria-pressed="true" after two 500 final GETs', async () => {
    const listUrl = '/api/lists/list-1';
    const putUrl = '/api/lists/list-1/items/item-1';
    const importUrl = '/api/lists/import-text';
    const control = stubF7Fetch();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    control.queueResponse('GET', listUrl, () =>
      Response.json({ id: 'list-1', name: 'Покупки', items: [milk] })
    );
    control.queueResponse('POST', importUrl, () =>
      Response.json({
        results: {
          added: [{ name: 'Сыр', category: 'Молочное' }],
          created: [],
          skipped: [],
          failed: [],
        },
      })
    );
    const releaseOldGet1 = control.hold('GET', listUrl);
    const releaseOldGetRetry = control.hold('GET', listUrl);
    const releasePut = control.hold('PUT', putUrl);
    const releaseFinal1 = control.hold('GET', listUrl);
    const releaseFinal2 = control.hold('GET', listUrl);

    const retryClient = makeRetryOneClient();
    renderPage(retryClient);

    const toggle = () => screen.queryByRole('button', { name: 'Куплено: Молоко' });
    const query = () =>
      retryClient.getQueryCache().find({ queryKey: queryKeys.list('list-1'), exact: true });
    const cached = () =>
      retryClient
        .getQueryData<{ items?: Array<{ id: string; isPurchased: boolean }> }>(
          queryKeys.list('list-1')
        )
        ?.items?.map(({ id, isPurchased }) => [id, isPurchased]) ?? null;

    expect(await screen.findByText('Молоко')).toBeTruthy();
    await runImportModal('Сыр');
    await waitFor(() => expect(control.hits.filter((hit) => hit.method === 'GET')).toHaveLength(2));

    fireEvent.click(toggle()!);
    await waitFor(() =>
      expect(control.hits.at(-1)).toMatchObject({
        method: 'PUT',
        url: putUrl,
        body: { isPurchased: true },
      })
    );

    await act(async () => {
      releaseOldGet1(Response.json({ id: 'list-1', name: 'Покупки', items: null }));
    });
    await waitFor(() => expect(control.hits.filter((hit) => hit.method === 'GET')).toHaveLength(3));
    expect(cached()).toEqual([['item-1', true]]);

    // Old GET retry resolves with valid stale false before PUT 204 arrives.
    await act(async () => {
      releaseOldGetRetry(Response.json({ id: 'list-1', name: 'Покупки', items: [milk] }));
    });
    await waitFor(() => expect(query()?.state.fetchStatus).toBe('idle'));
    expect(toggle()).toBeDisabled();

    await act(async () => {
      releasePut(new Response(null, { status: 204 }));
    });
    await waitFor(() => expect(control.hits.filter((hit) => hit.method === 'GET')).toHaveLength(4));
    await act(async () => {
      releaseFinal1(Response.json({ error: 'boom' }, { status: 500 }));
    });
    await waitFor(() => expect(control.hits.filter((hit) => hit.method === 'GET')).toHaveLength(5));
    await act(async () => {
      releaseFinal2(Response.json({ error: 'boom' }, { status: 500 }));
    });

    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(cached()).toEqual([['item-1', true]]);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(toggle()?.closest('.group')).not.toHaveAttribute('aria-busy');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.filter(([message]) => message === 'List item action failed:')
    ).toEqual([]);
    expect(control.settled.map(({ method, url, status }) => [method, url, status])).toEqual([
      ['GET', listUrl, 200],
      ['POST', importUrl, 200],
      ['GET', listUrl, 200],
      ['GET', listUrl, 200],
      ['PUT', putUrl, 204],
      ['GET', listUrl, 500],
      ['GET', listUrl, 500],
    ]);
  });

  it('F7 mounted page: applies valid items:[] on retry after malformed GET and preserves empty state against subsequent malformed GET', async () => {
    const listUrl = '/api/lists/list-1';
    const control = stubF7Fetch();

    control.queueResponse('GET', listUrl, () =>
      Response.json({ id: 'list-1', name: 'Покупки', items: [milk] })
    );
    control.queueResponse('GET', listUrl, () =>
      Response.json({ id: 'list-1', name: 'Покупки', items: null })
    );
    control.queueResponse('GET', listUrl, () =>
      Response.json({ id: 'list-1', name: 'Покупки', items: [] })
    );

    const retryClient = makeRetryOneClient();
    renderPage(retryClient);
    expect(await screen.findByText('Молоко')).toBeTruthy();

    await act(async () => {
      await retryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    });

    expect(await screen.findByText('Покупки пуст')).toBeTruthy();
    expect(retryClient.getQueryData<{ items: Item[] }>(queryKeys.list('list-1'))?.items).toEqual(
      []
    );

    control.queueResponse('GET', listUrl, () => Response.json({ id: 'list-1', name: 'Покупки' }));
    control.queueResponse('GET', listUrl, () => Response.json({ error: 'boom' }, { status: 500 }));
    await act(async () => {
      await retryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    });

    expect(screen.getByText('Покупки пуст')).toBeTruthy();
    expect(retryClient.getQueryData<{ items: Item[] }>(queryKeys.list('list-1'))?.items).toEqual(
      []
    );
  });
});

describe('F8 required GET retry survives unmount and remount (AGE-1649)', () => {
  const listUrl = '/api/lists/list-1';
  const putUrl = '/api/lists/list-1/items/item-1';
  const serverNote = 'серверная заметка';

  const getHits = (hits: JournalHit[]) => hits.filter((hit) => hit.method === 'GET');
  const putHits = (hits: JournalHit[]) => hits.filter((hit) => hit.method === 'PUT');
  const queryOf = (client: QueryClient) =>
    client.getQueryCache().find({ queryKey: queryKeys.list('list-1'), exact: true });
  const toggleBtn = () => screen.queryByRole('button', { name: 'Куплено: Молоко' });

  it('F8 mounted page 500 -> 200: remounting during held first required GET keeps retry alive, locks until retry 200, applies server false and note, logs once with rowFailed and sends no extra GET', async () => {
    const control = stubControlledFetch();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    control.queueResponse('GET', listUrl, () =>
      Response.json({ id: 'list-1', name: 'Покупки', items: [milk] })
    );
    control.queueResponse('PUT', putUrl, () =>
      Response.json({ error: 'unauthorized' }, { status: 401 })
    );
    const releaseRequired1 = control.hold('GET', listUrl);
    const releaseRequired2 = control.hold('GET', listUrl);

    const sharedClient = makeProductionRetryClient();
    const firstView = renderPage(sharedClient);
    expect(await screen.findByText('Молоко')).toBeTruthy();

    fireEvent.click(toggleBtn()!);
    await waitFor(() => expect(getHits(control.hits)).toHaveLength(2));

    firstView.unmount();
    renderPage(sharedClient);
    expect(await screen.findByText('Молоко')).toBeTruthy();
    expect(getHits(control.hits)).toHaveLength(2);
    expect(toggleBtn()?.closest('.group')).toHaveAttribute('aria-busy', 'true');
    expect(toggleBtn()).toBeDisabled();

    await act(async () => {
      releaseRequired1(Response.json({ error: 'boom' }, { status: 500 }));
    });
    await waitFor(() => expect(getHits(control.hits)).toHaveLength(3), { timeout: 2500 });
    expect(toggleBtn()?.closest('.group')).toHaveAttribute('aria-busy', 'true');
    expect(toggleBtn()).toBeDisabled();

    await act(async () => {
      releaseRequired2(
        Response.json({
          id: 'list-1',
          name: 'Покупки',
          items: [{ ...milk, isPurchased: false, note: serverNote }],
        })
      );
    });

    await waitFor(() => expect(queryOf(sharedClient)?.state.fetchStatus).toBe('idle'));
    await waitFor(() => expect(toggleBtn()).toBeEnabled());

    expect(putHits(control.hits)).toHaveLength(1);
    expect(getHits(control.hits)).toHaveLength(3);
    expect(toggleBtn()).toHaveAttribute('aria-pressed', 'false');
    expect(toggleBtn()?.closest('.group')).not.toHaveAttribute('aria-busy');
    expect(screen.getByText(serverNote)).toBeTruthy();
    expect(
      sharedClient.getQueryData<{ items: Item[] }>(queryKeys.list('list-1'))?.items[0]
    ).toMatchObject({ isPurchased: false, note: serverNote });
    expect(
      errorSpy.mock.calls.filter(([message]) => message === 'List item action failed:')
    ).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith('Не удалось выполнить действие');
    expect(control.settled.map(({ method, url, status }) => [method, url, status])).toEqual([
      ['GET', listUrl, 200],
      ['PUT', putUrl, 401],
      ['GET', listUrl, 500],
      ['GET', listUrl, 200],
    ]);

    sharedClient.clear();
  });

  it('F8 mounted page 500 -> 500: remounting during held first required GET still runs second GET, preserves current display, unlocks, logs once with reloadFailed and sends no third GET', async () => {
    const control = stubControlledFetch();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    control.queueResponse('GET', listUrl, () =>
      Response.json({ id: 'list-1', name: 'Покупки', items: [milk] })
    );
    control.queueResponse('PUT', putUrl, () =>
      Response.json({ error: 'unauthorized' }, { status: 401 })
    );
    const releaseRequired1 = control.hold('GET', listUrl);
    const releaseRequired2 = control.hold('GET', listUrl);

    const sharedClient = makeProductionRetryClient();
    const firstView = renderPage(sharedClient);
    expect(await screen.findByText('Молоко')).toBeTruthy();

    fireEvent.click(toggleBtn()!);
    await waitFor(() => expect(getHits(control.hits)).toHaveLength(2));

    firstView.unmount();
    renderPage(sharedClient);
    expect(await screen.findByText('Молоко')).toBeTruthy();

    await act(async () => {
      releaseRequired1(Response.json({ error: 'boom' }, { status: 500 }));
    });
    await waitFor(() => expect(getHits(control.hits)).toHaveLength(3), { timeout: 2500 });
    expect(toggleBtn()?.closest('.group')).toHaveAttribute('aria-busy', 'true');
    expect(toggleBtn()).toBeDisabled();

    await act(async () => {
      releaseRequired2(Response.json({ error: 'boom' }, { status: 500 }));
    });

    await waitFor(() => expect(queryOf(sharedClient)?.state.fetchStatus).toBe('idle'));
    await waitFor(() => expect(toggleBtn()).toBeEnabled());

    expect(putHits(control.hits)).toHaveLength(1);
    expect(getHits(control.hits)).toHaveLength(3);
    expect(toggleBtn()).toHaveAttribute('aria-pressed', 'true');
    expect(toggleBtn()?.closest('.group')).not.toHaveAttribute('aria-busy');
    expect(
      sharedClient.getQueryData<{ items: Item[] }>(queryKeys.list('list-1'))?.items[0]
    ).toMatchObject({ isPurchased: true });
    expect(
      errorSpy.mock.calls.filter(([message]) => message === 'List item action failed:')
    ).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith('Не удалось обновить список');
    expect(control.settled.map(({ method, url, status }) => [method, url, status])).toEqual([
      ['GET', listUrl, 200],
      ['PUT', putUrl, 401],
      ['GET', listUrl, 500],
      ['GET', listUrl, 500],
    ]);

    sharedClient.clear();
  });

  it('F8 unmounted gap order: first 500 delivered while no page is mounted still triggers retry GET, and remounting does not add an extra GET', async () => {
    const control = stubControlledFetch();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    control.queueResponse('GET', listUrl, () =>
      Response.json({ id: 'list-1', name: 'Покупки', items: [milk] })
    );
    control.queueResponse('PUT', putUrl, () =>
      Response.json({ error: 'unauthorized' }, { status: 401 })
    );
    const releaseRequired1 = control.hold('GET', listUrl);
    const releaseRequired2 = control.hold('GET', listUrl);

    const sharedClient = makeProductionRetryClient();
    const firstView = renderPage(sharedClient);
    expect(await screen.findByText('Молоко')).toBeTruthy();

    fireEvent.click(toggleBtn()!);
    await waitFor(() => expect(getHits(control.hits)).toHaveLength(2));

    firstView.unmount();

    // Deliver the first 500 while no page observer is mounted at all.
    await act(async () => {
      releaseRequired1(Response.json({ error: 'boom' }, { status: 500 }));
    });
    await waitFor(() => expect(getHits(control.hits)).toHaveLength(3), { timeout: 2500 });
    expect(alertSpy).not.toHaveBeenCalled();

    // Return to the page while the retry GET is in flight: must attach to busy state without extra GET.
    renderPage(sharedClient);
    expect(await screen.findByText('Молоко')).toBeTruthy();
    expect(getHits(control.hits)).toHaveLength(3);
    expect(toggleBtn()?.closest('.group')).toHaveAttribute('aria-busy', 'true');
    expect(toggleBtn()).toBeDisabled();

    await act(async () => {
      releaseRequired2(
        Response.json({
          id: 'list-1',
          name: 'Покупки',
          items: [{ ...milk, isPurchased: false, note: serverNote }],
        })
      );
    });

    await waitFor(() => expect(queryOf(sharedClient)?.state.fetchStatus).toBe('idle'));
    await waitFor(() => expect(toggleBtn()).toBeEnabled());

    expect(putHits(control.hits)).toHaveLength(1);
    expect(getHits(control.hits)).toHaveLength(3);
    expect(toggleBtn()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(serverNote)).toBeTruthy();
    expect(
      errorSpy.mock.calls.filter(([message]) => message === 'List item action failed:')
    ).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith('Не удалось выполнить действие');
    expect(control.settled.map(({ method, url, status }) => [method, url, status])).toEqual([
      ['GET', listUrl, 200],
      ['PUT', putUrl, 401],
      ['GET', listUrl, 500],
      ['GET', listUrl, 200],
    ]);

    sharedClient.clear();
  });
});
