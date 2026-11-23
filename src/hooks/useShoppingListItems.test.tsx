import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { messages } from '@/i18n/messages';
import { queryKeys } from '@/lib/query-keys';
import { useShoppingListItems, type Item, type ListData } from './useShoppingListItems';
import { useImportListText } from './useListMutations';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const makeListData = (): ListData => ({
  id: 'list-1',
  name: 'Список',
  items: [
    {
      id: 'item-1',
      isPurchased: false,
      note: null,
      product: {
        id: 'prod-1',
        name: 'Молоко',
        emoji: '🥛',
        isCustom: false,
        imageUrl: null,
        category: { name: 'Молочные продукты', emoji: '🧀', order: 1 },
      },
      variant: null,
    },
    {
      id: 'item-2',
      isPurchased: true,
      note: null,
      product: {
        id: 'prod-2',
        name: 'Хлеб',
        emoji: '🍞',
        isCustom: false,
        imageUrl: null,
        category: { name: 'Выпечка', emoji: '🥐', order: 2 },
      },
      variant: null,
    },
  ],
});

type JournalEntry = { method: string; url: string; body: unknown };
type Queued =
  | { kind: 'reject'; error: unknown }
  | { kind: 'respond'; status: number; body: string | null }
  // Held until the test releases it; the released entry is then served as usual.
  | { kind: 'gate'; gate: Promise<Queued> }
  // Serve through the default handler (GET returns the current server state).
  | { kind: 'serve' };

const LIST_URL = '/api/lists/list-1';
const PUT_URL = '/api/lists/list-1/items/item-1';
const ITEM2_URL = '/api/lists/list-1/items/item-2';
const HISTORY_URL = '/api/history';
const IMPORT_URL = '/api/lists/import-text';
const SERVER_NOTE = 'заметка с сервера';
const SERVE: Queued = { kind: 'serve' };

let serverState: ListData;
let journal: JournalEntry[];
let queues: Map<string, Queued[]>;
let queryClient: QueryClient;
let rollbackWitness: ListData | undefined;
let setQueryDataSpy: ReturnType<typeof vi.spyOn>;
let invalidateSpy: ReturnType<typeof vi.spyOn>;

const key = (method: string, url: string) => `${method} ${url}`;

function enqueue(method: string, url: string, queued: Queued[]) {
  queues.set(key(method, url), [...(queues.get(key(method, url)) ?? []), ...queued]);
}

// Holds the next request to `method url` until the test releases it.
function holdNext(method: string, url: string) {
  let release!: (queued: Queued) => void;
  const gate = new Promise<Queued>((resolve) => {
    release = resolve;
  });
  enqueue(method, url, [{ kind: 'gate', gate }]);
  return (queued: Queued = SERVE) => release(queued);
}

const putReject = (): Queued => ({ kind: 'reject', error: new TypeError('fetch failed') });
const putRespond = (status: number, body: string | null): Queued => ({
  kind: 'respond',
  status,
  body,
});

const methodJournal = (method: string) => journal.filter((entry) => entry.method === method);
const putJournal = () => methodJournal('PUT');
const deleteUrls = () => methodJournal('DELETE').map((entry) => entry.url);
const getCount = () => methodJournal('GET').length;
const noteWrites = () =>
  putJournal().filter(
    (entry) => typeof entry.body === 'object' && entry.body !== null && 'note' in entry.body
  );

function applyServerWrite(method: string, url: string, body: unknown, status: number) {
  const itemId = /\/items\/([^/]+)$/.exec(url)?.[1];
  if (!itemId) return;
  if (method === 'PUT' && status >= 200 && status < 300 && body && typeof body === 'object') {
    const patch = body as { isPurchased?: unknown };
    if (typeof patch.isPurchased === 'boolean') {
      const isPurchased = patch.isPurchased;
      serverState = {
        ...serverState,
        items: serverState.items.map((item) =>
          item.id === itemId ? { ...item, isPurchased } : item
        ),
      };
    }
  }
  if (method === 'DELETE' && status >= 200 && status < 300) {
    serverState = {
      ...serverState,
      items: serverState.items.filter((item) => item.id !== itemId),
    };
  }
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      journal.push({ method, url, body });

      let next = queues.get(key(method, url))?.shift();
      while (next?.kind === 'gate') next = await next.gate;
      if (next?.kind === 'serve') next = undefined;
      if (next?.kind === 'reject') {
        throw next.error;
      }
      if (next?.kind === 'respond') {
        applyServerWrite(method, url, body, next.status);
        return new Response(next.body, { status: next.status });
      }
      if (method === 'GET') {
        return new Response(JSON.stringify(serverState), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    })
  );
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

const step = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function renderList() {
  const rendered = renderHook(() => useShoppingListItems('list-1'), { wrapper });
  await step(0);
  rollbackWitness = queryClient.getQueryData<ListData>(queryKeys.list('list-1'));
  return rendered;
}

function startToggle(result: { current: { togglePurchased: (itemId: string) => Promise<void> } }) {
  return result.current.togglePurchased('item-1').catch((error: unknown) => error);
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error
  );

function currentItem(itemId = 'item-1') {
  const data = queryClient.getQueryData<ListData>(queryKeys.list('list-1'));
  const item = data?.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`item ${itemId} not in cache`);
  return item;
}

const hasItem = (itemId = 'item-1') =>
  queryClient
    .getQueryData<ListData>(queryKeys.list('list-1'))
    ?.items.some((candidate) => candidate.id === itemId) ?? false;

function setServerItem(itemId: string, patch: Partial<Item>) {
  serverState = {
    ...serverState,
    items: serverState.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
  };
}

function spyDialogs() {
  return {
    alert: vi.spyOn(window, 'alert').mockImplementation(() => undefined),
    confirm: vi.spyOn(window, 'confirm').mockReturnValue(true),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
}

const rollbackCount = () =>
  setQueryDataSpy.mock.calls.filter((call: unknown) => {
    const [queryKey, value] = call as [readonly unknown[], unknown];
    return Array.isArray(queryKey) && queryKey[0] === 'list' && value === rollbackWitness;
  }).length;

beforeEach(() => {
  vi.useFakeTimers();
  serverState = makeListData();
  journal = [];
  queues = new Map();
  onlineManager.setOnline(true);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } },
  });
  setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  stubFetch();
});

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe('togglePurchased retry/ACK contract (N1)', () => {
  it('AC-1: four transport rejects keep the optimistic value until the terminal reload settles; no snapshot restore', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    const { result } = await renderList();
    const releaseReload = holdNext('GET', LIST_URL);
    const done = startToggle(result);

    await step(0);
    expect(putJournal()).toHaveLength(1);
    expect(currentItem().isPurchased).toBe(true);

    await step(999);
    expect(putJournal()).toHaveLength(1);
    await step(1);
    expect(putJournal()).toHaveLength(2);
    expect(currentItem().isPurchased).toBe(true);

    await step(1999);
    expect(putJournal()).toHaveLength(2);
    await step(1);
    expect(putJournal()).toHaveLength(3);
    expect(currentItem().isPurchased).toBe(true);

    await step(3999);
    expect(putJournal()).toHaveLength(3);
    await step(1);
    expect(putJournal()).toHaveLength(4);

    await step(10_000);
    expect(putJournal()).toHaveLength(4);
    // Held terminal witness: the reload is in flight, so the value is still the optimistic one
    // and the cache was never set back to the pre-toggle snapshot.
    expect.soft(currentItem().isPurchased).toBe(true);
    expect.soft(rollbackCount()).toBe(0);

    setServerItem('item-1', { note: SERVER_NOTE });
    releaseReload();
    await done;
    for (const entry of putJournal()) {
      expect(entry.body).toEqual({ isPurchased: true });
    }
    // Distinct final GET marker: the note exists only on the server, not in the snapshot.
    expect(currentItem().isPurchased).toBe(false);
    expect(currentItem().note).toBe(SERVER_NOTE);
    expect.soft(rollbackCount()).toBe(0);

    await step(10_000);
    expect(putJournal()).toHaveLength(4);
  });

  it('AC-2: two transport rejects then 200 with valid JSON confirm delivery; exactly 3 PUTs and no rollback', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putRespond(200, '{"isPurchased":true}')]);
    const { result } = await renderList();
    const done = startToggle(result);

    await step(0);
    await step(1000);
    await step(2000);
    await step(10_000);

    expect(putJournal()).toHaveLength(3);
    expect(rollbackCount()).toBe(0);
    expect(currentItem().isPurchased).toBe(true);
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.list('list-1') }),
      // Ordinary refresh after a write: it must not cancel a running read (AGE-1649).
      expect.objectContaining({ cancelRefetch: false })
    );

    await done;
    expect(putJournal()).toHaveLength(3);

    await step(10_000);
    expect(putJournal()).toHaveLength(3);
  });

  it.each([
    {
      name: 'AC-3a: 200 with an unparsable JSON body after two rejects is still an ACK',
      queue: [putReject(), putReject(), putRespond(200, '{"isPurchased":')],
      expectedPuts: 3,
    },
    {
      name: 'AC-3b: 204 No Content after one reject is still an ACK',
      queue: [putReject(), putRespond(204, null)],
      expectedPuts: 2,
    },
    {
      name: 'AC-3c: 201 Created with JSON after one reject is still an ACK',
      queue: [putReject(), putRespond(201, '{"isPurchased":true}')],
      expectedPuts: 2,
    },
  ])('$name', async ({ queue, expectedPuts }) => {
    enqueue('PUT', PUT_URL, queue);
    const { result } = await renderList();
    const done = startToggle(result);

    await step(0);
    await step(1000);
    await step(2000);
    await step(10_000);

    expect(putJournal()).toHaveLength(expectedPuts);
    expect(rollbackCount()).toBe(0);
    expect(currentItem().isPurchased).toBe(true);
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.list('list-1') }),
      // Ordinary refresh after a write: it must not cancel a running read (AGE-1649).
      expect.objectContaining({ cancelRefetch: false })
    );

    await done;

    await step(10_000);
    expect(putJournal()).toHaveLength(expectedPuts);
  });

  it.each([
    { name: 'transport TypeError', queued: () => putReject() },
    { name: 'HTTP 408', queued: () => putRespond(408, 'request timeout') },
    { name: 'HTTP 429', queued: () => putRespond(429, 'rate limited') },
    { name: 'HTTP 500', queued: () => putRespond(500, 'internal error') },
    { name: 'HTTP 503', queued: () => putRespond(503, 'service unavailable') },
  ])(
    'AC-4 retryable: $name exhausts the budget of 4 PUTs; the terminal reload replaces the optimistic value',
    async ({ queued }) => {
      enqueue('PUT', PUT_URL, [queued(), queued(), queued(), queued()]);
      const { result } = await renderList();
      const releaseReload = holdNext('GET', LIST_URL);
      const done = startToggle(result);

      await step(0);
      await step(1000);
      await step(2000);
      await step(4000);
      await step(10_000);

      expect(putJournal()).toHaveLength(4);
      expect.soft(currentItem().isPurchased).toBe(true);
      expect.soft(rollbackCount()).toBe(0);

      setServerItem('item-1', { note: SERVER_NOTE });
      releaseReload();
      await done;

      expect(currentItem().note).toBe(SERVER_NOTE);
      expect.soft(rollbackCount()).toBe(0);

      await step(10_000);
      expect(putJournal()).toHaveLength(4);
    }
  );

  it.each([
    { name: 'HTTP 400', status: 400 },
    { name: 'HTTP 401', status: 401 },
    { name: 'HTTP 403', status: 403 },
    { name: 'HTTP 404', status: 404 },
    { name: 'HTTP 422', status: 422 },
    { name: 'HTTP 302 (fail-closed, out of class)', status: 302 },
  ])(
    'AC-4 permanent: $name yields exactly one PUT, no retry, and the terminal reload replaces the optimistic value',
    async ({ status }) => {
      enqueue('PUT', PUT_URL, [putRespond(status, 'error')]);
      const { result } = await renderList();
      const releaseReload = holdNext('GET', LIST_URL);
      const done = startToggle(result);

      await step(0);
      await step(10_000);

      expect(putJournal()).toHaveLength(1);
      expect.soft(currentItem().isPurchased).toBe(true);
      expect.soft(rollbackCount()).toBe(0);

      setServerItem('item-1', { note: SERVER_NOTE });
      releaseReload();
      await done;

      expect(putJournal()).toHaveLength(1);
      expect(currentItem().note).toBe(SERVER_NOTE);
      expect.soft(rollbackCount()).toBe(0);
    }
  );

  it.each([
    { name: 'HTTP 200 with valid JSON', respond: () => putRespond(200, '{"isPurchased":true}') },
    { name: 'HTTP 201 with JSON', respond: () => putRespond(201, '{"isPurchased":true}') },
    { name: 'HTTP 204 No Content', respond: () => putRespond(204, null) },
  ])(
    'AC-4 success: $name is an ACK; the cycle ends without retry or rollback',
    async ({ respond }) => {
      enqueue('PUT', PUT_URL, [respond()]);
      const { result } = await renderList();
      const done = startToggle(result);

      await step(0);
      await step(10_000);

      expect(putJournal()).toHaveLength(1);
      expect(rollbackCount()).toBe(0);
      expect(currentItem().isPurchased).toBe(true);
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: queryKeys.list('list-1') }),
        // Ordinary refresh after a write: it must not cancel a running read (AGE-1649).
        expect.objectContaining({ cancelRefetch: false })
      );

      await done;
    }
  );

  it('AC-5: first reject pauses offline during backoff; online resumes the same cycle with the remaining budget', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    const { result } = await renderList();
    const releaseReload = holdNext('GET', LIST_URL);
    const done = startToggle(result);

    await step(0);
    expect(putJournal()).toHaveLength(1);

    act(() => onlineManager.setOnline(false));
    await step(1000);
    expect(putJournal()).toHaveLength(1);
    await step(10_000);
    expect(putJournal()).toHaveLength(1);
    expect(currentItem().isPurchased).toBe(true);
    expect(rollbackCount()).toBe(0);

    await act(async () => {
      onlineManager.setOnline(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(putJournal()).toHaveLength(2);

    await step(1999);
    expect(putJournal()).toHaveLength(2);
    await step(1);
    expect(putJournal()).toHaveLength(3);

    await step(3999);
    expect(putJournal()).toHaveLength(3);
    await step(1);
    expect(putJournal()).toHaveLength(4);

    await step(10_000);
    expect(putJournal()).toHaveLength(4);
    expect.soft(currentItem().isPurchased).toBe(true);
    expect.soft(rollbackCount()).toBe(0);

    setServerItem('item-1', { note: SERVER_NOTE });
    releaseReload();
    await done;
    expect(putJournal()).toHaveLength(4);
    expect(currentItem().note).toBe(SERVER_NOTE);
    expect.soft(rollbackCount()).toBe(0);
  });

  it.each([
    { name: 'transport reject then HTTP 401', second: () => putRespond(401, 'unauthorized') },
    { name: 'transport reject then HTTP 302', second: () => putRespond(302, 'redirect') },
  ])(
    'FR-1 neighbor: $name — exactly two PUTs with the same body, the terminal reload replaces the optimistic value, no extra PUT',
    async ({ second }) => {
      enqueue('PUT', PUT_URL, [putReject(), second()]);
      const { result } = await renderList();
      const releaseReload = holdNext('GET', LIST_URL);
      const done = startToggle(result);

      await step(0);
      await step(1000);
      await step(10_000);

      expect(putJournal()).toHaveLength(2);
      for (const entry of putJournal()) {
        expect(entry.body).toEqual({ isPurchased: true });
      }
      expect.soft(currentItem().isPurchased).toBe(true);
      expect.soft(rollbackCount()).toBe(0);

      setServerItem('item-1', { note: SERVER_NOTE });
      releaseReload();
      await done;
      expect(putJournal()).toHaveLength(2);
      expect(currentItem().note).toBe(SERVER_NOTE);
    }
  );
});

describe('row lock and terminal reload (AGE-1649)', () => {
  it('AC-1: a second same-tick toggle of a row whose PUT is in flight sends no request', async () => {
    const releasePut = holdNext('PUT', PUT_URL);
    const { result } = await renderList();

    const first = startToggle(result);
    const second = settle(result.current.togglePurchased('item-1'));
    await step(0);

    expect(putJournal()).toHaveLength(1);

    await act(async () => {
      releasePut(putRespond(200, '{"isPurchased":true}'));
      await Promise.all([first, second]);
    });
    expect(putJournal()).toHaveLength(1);
  });

  it('AC-1: removing a row whose PUT is in flight sends no DELETE', async () => {
    const releasePut = holdNext('PUT', PUT_URL);
    const { result } = await renderList();

    const first = startToggle(result);
    await step(0);
    const removal = settle(result.current.removeItem('item-1'));
    await step(0);

    expect(methodJournal('DELETE')).toHaveLength(0);

    await act(async () => {
      releasePut(putRespond(200, '{"isPurchased":true}'));
      await Promise.all([first, removal]);
    });
  });

  it('AC-1: a note save on a row whose PUT is in flight sends no note PUT', async () => {
    const releasePut = holdNext('PUT', PUT_URL);
    const { result } = await renderList();

    const first = startToggle(result);
    await step(0);
    const noteSave = settle(result.current.updateNote('item-1', 'срочно'));
    await step(0);

    expect(noteWrites()).toHaveLength(0);

    await act(async () => {
      releasePut(putRespond(200, '{"isPurchased":true}'));
      await Promise.all([first, noteSave]);
    });
  });

  it('AC-1: clear-all while a row is busy sends no DELETE for any row', async () => {
    spyDialogs();
    const releasePut = holdNext('PUT', PUT_URL);
    const { result } = await renderList();

    const first = startToggle(result);
    await step(0);
    const clear = settle(result.current.clearAll());
    await step(0);

    expect(methodJournal('DELETE')).toHaveLength(0);

    await act(async () => {
      releasePut(putRespond(200, '{"isPurchased":true}'));
      await Promise.all([first, clear]);
    });
  });

  it('AC-1 neighbour: a row that is not busy still accepts its own toggle while another row is in flight', async () => {
    const releasePut = holdNext('PUT', PUT_URL);
    enqueue('PUT', ITEM2_URL, [putRespond(200, '{"isPurchased":false}')]);
    const { result } = await renderList();

    const first = startToggle(result);
    await step(0);
    const neighbour = settle(result.current.togglePurchased('item-2'));
    await step(0);

    expect(
      journal.filter((entry) => entry.url === ITEM2_URL && entry.method === 'PUT')
    ).toHaveLength(1);

    await act(async () => {
      releasePut(putRespond(200, '{"isPurchased":true}'));
      await Promise.all([first, neighbour]);
    });
  });

  it('AC-6: during a clear-all batch a second clear-all, a toggle and a remove of a batch row send no requests', async () => {
    const dialogs = spyDialogs();
    const releaseFirstDelete = holdNext('DELETE', PUT_URL);
    enqueue('DELETE', ITEM2_URL, [putRespond(200, '{}')]);
    const { result } = await renderList();

    const firstClear = settle(result.current.clearAll());
    await step(0);
    expect(deleteUrls()).toEqual([PUT_URL]);

    const secondClear = settle(result.current.clearAll());
    const toggleBatchRow = settle(result.current.togglePurchased('item-2'));
    const removeBatchRow = settle(result.current.removeItem('item-2'));
    await step(0);

    expect(deleteUrls()).toEqual([PUT_URL]);
    expect(putJournal()).toHaveLength(0);

    await act(async () => {
      releaseFirstDelete(putRespond(200, '{}'));
      await Promise.all([firstClear, secondClear, toggleBatchRow, removeBatchRow]);
    });
  });

  it('AC-6: a clear-all batch of two rows reserves both rows and issues the DELETEs one at a time', async () => {
    const dialogs = spyDialogs();
    const releaseFirstDelete = holdNext('DELETE', PUT_URL);
    enqueue('DELETE', ITEM2_URL, [putRespond(200, '{}')]);
    const { result } = await renderList();
    const getsBefore = getCount();

    const clear = settle(result.current.clearAll());
    await step(0);

    expect(deleteUrls()).toEqual([PUT_URL]);
    const toggleSecond = settle(result.current.togglePurchased('item-2'));
    await step(0);
    expect(putJournal()).toHaveLength(0);

    await act(async () => {
      releaseFirstDelete(putRespond(200, '{}'));
      await Promise.all([clear, toggleSecond]);
    });
    expect(dialogs.alert).toHaveBeenCalledTimes(0);
    expect(getCount() - getsBefore).toBe(1);
  });

  it('AC-6 all success: a 404 on the first row counts as success; the batch ends with one final refresh only', async () => {
    const dialogs = spyDialogs();
    const releaseFirstDelete = holdNext('DELETE', PUT_URL);
    enqueue('DELETE', ITEM2_URL, [putRespond(200, '{}')]);
    const { result } = await renderList();
    const getsBefore = getCount();
    // The list shows item-1, but the server no longer has it, so its DELETE answers 404.
    serverState = { ...serverState, items: serverState.items.filter((i) => i.id !== 'item-1') };

    const clear = settle(result.current.clearAll());
    await step(0);
    expect(deleteUrls()).toEqual([PUT_URL]);

    await act(async () => {
      releaseFirstDelete(putRespond(404, 'gone'));
      await clear;
    });

    expect(deleteUrls()).toEqual([PUT_URL, ITEM2_URL]);
    expect(getCount() - getsBefore).toBe(1);
    expect(hasItem('item-1')).toBe(false);
    expect(hasItem('item-2')).toBe(false);
    expect(dialogs.alert).toHaveBeenCalledTimes(0);
  });

  it('AC-6 failure: [A,B,C] with B failing sends no DELETE for C, one final refresh, server rows kept, one message and one log', async () => {
    const dialogs = spyDialogs();
    serverState = {
      ...serverState,
      items: [
        ...serverState.items,
        {
          ...serverState.items[1],
          id: 'item-3',
          product: { ...serverState.items[1].product, id: 'prod-3', name: 'Сыр' },
        },
      ],
    };
    enqueue('DELETE', PUT_URL, [putRespond(200, '{}')]);
    enqueue('DELETE', ITEM2_URL, [putRespond(500, 'boom')]);
    const { result } = await renderList();
    const getsBefore = getCount();

    await settle(result.current.clearAll());

    expect(deleteUrls()).toEqual([PUT_URL, ITEM2_URL]);
    expect(getCount() - getsBefore).toBe(1);
    expect(hasItem('item-1')).toBe(false);
    expect(hasItem('item-2')).toBe(true);
    expect(hasItem('item-3')).toBe(true);
    expect(dialogs.alert).toHaveBeenCalledTimes(1);
    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось выполнить действие');
    expect(dialogs.error).toHaveBeenCalledTimes(1);
  });

  it('AC-6 single failure: a failed DELETE keeps the row visible while in flight and shows the server row after the reload', async () => {
    const dialogs = spyDialogs();
    const releaseDelete = holdNext('DELETE', PUT_URL);
    const { result } = await renderList();
    const releaseReload = holdNext('GET', LIST_URL);

    const removal = settle(result.current.removeItem('item-1'));
    await step(0);
    // A pending remove stays visible with its indicator; it is not hidden optimistically.
    expect.soft(hasItem('item-1')).toBe(true);

    releaseDelete(putRespond(500, 'boom'));
    await step(0);
    // The reload is in flight: the row is still there and no message is shown yet.
    expect(hasItem('item-1')).toBe(true);
    expect(dialogs.alert).toHaveBeenCalledTimes(0);

    releaseReload();
    await removal;
    expect(hasItem('item-1')).toBe(true);
    expect(dialogs.alert).toHaveBeenCalledTimes(1);
    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось выполнить действие');
    expect(dialogs.error).toHaveBeenCalledTimes(1);
  });

  it('AC-3: the row stays locked until the reload settles; server values show; one message, one log; then unlock', async () => {
    const dialogs = spyDialogs();
    enqueue('PUT', PUT_URL, [
      putReject(),
      putReject(),
      putReject(),
      putReject(),
      putRespond(200, '{"isPurchased":false}'),
    ]);
    const { result } = await renderList();
    const releaseReload = holdNext('GET', LIST_URL);
    const done = startToggle(result);

    await step(0);
    await step(1000);
    await step(2000);
    await step(4000);
    await step(10_000);
    expect(putJournal()).toHaveLength(4);

    // While the reload is in flight the row accepts nothing new.
    await settle(result.current.togglePurchased('item-1'));
    await settle(result.current.removeItem('item-1'));
    await settle(result.current.updateNote('item-1', 'x'));
    await settle(result.current.clearAll());
    expect.soft(putJournal()).toHaveLength(4);
    expect.soft(methodJournal('DELETE')).toHaveLength(0);

    setServerItem('item-1', { isPurchased: true, note: SERVER_NOTE });
    releaseReload();
    await done;

    expect(currentItem().isPurchased).toBe(true);
    expect(currentItem().note).toBe(SERVER_NOTE);
    expect(dialogs.alert).toHaveBeenCalledTimes(1);
    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось выполнить действие');
    expect(dialogs.error).toHaveBeenCalledTimes(1);

    // Unlock: after the cycle ends the row accepts a new request.
    await settle(result.current.togglePurchased('item-1'));
    expect(putJournal()).toHaveLength(5);
  });

  it('AC-7: production retry 1 with two failed reload GETs: no third GET, cache unchanged by the failure, unlock, one log and one message', async () => {
    const dialogs = spyDialogs();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, staleTime: 5 * 60 * 1000 } },
    });
    const releasePut = holdNext('PUT', PUT_URL);
    const { result } = await renderList();
    enqueue('GET', LIST_URL, [putRespond(500, 'boom'), putRespond(500, 'boom')]);
    const done = startToggle(result);
    await step(0);
    const before = { ...currentItem() };
    expect(before.isPurchased).toBe(true);

    await act(async () => {
      releasePut(putRespond(401, 'unauthorized'));
      await Promise.resolve();
    });
    await step(60_000);
    await step(120_000);
    await done;

    const after = { ...currentItem() };
    // The failed reload leaves the current display as it was: not the old snapshot.
    expect.soft(after).toEqual(before);
    expect.soft(after.isPurchased).toBe(true);
    // Exactly the mount GET plus two failed reload GETs (retry 1); no third, no fallback 200.
    expect(getCount()).toBe(3);
    expect(dialogs.error).toHaveBeenCalledTimes(1);
    expect(dialogs.alert).toHaveBeenCalledTimes(1);
    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось обновить список');

    enqueue('PUT', PUT_URL, [putRespond(200, '{"isPurchased":true}')]);
    await settle(result.current.togglePurchased('item-1'));
    expect(putJournal()).toHaveLength(2);
  });

  it('N2: an import invalidation must not cancel the held required reload of this list', async () => {
    const dialogs = spyDialogs();
    enqueue('PUT', PUT_URL, [putRespond(401, 'unauthorized')]);
    enqueue('POST', IMPORT_URL, [
      putRespond(
        200,
        JSON.stringify({ results: { added: [], created: [], skipped: [], failed: [] } })
      ),
    ]);
    const rendered = renderHook(
      () => ({ list: useShoppingListItems('list-1'), importer: useImportListText() }),
      { wrapper }
    );
    await step(0);
    const releaseReload = holdNext('GET', LIST_URL);
    const done = settle(rendered.result.current.list.togglePurchased('item-1'));
    await step(0);

    // Mount GET plus the held required reload.
    expect(getCount()).toBe(2);
    const getsBeforeImport = getCount();

    await act(async () => {
      await rendered.result.current.importer.mutateAsync({ listId: 'list-1', text: 'Молоко' });
    });
    await step(0);

    // The import refresh must not start another list read over the held required reload.
    expect(getCount()).toBe(getsBeforeImport);

    setServerItem('item-1', { note: SERVER_NOTE });
    releaseReload();
    await done;
    expect(currentItem().note).toBe(SERVER_NOTE);
    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось выполнить действие');
  });

  it('complete vs row: a row whose PUT is in flight blocks completeList (no history POST)', async () => {
    enqueue('POST', HISTORY_URL, [putRespond(200, '{}')]);
    const releasePut = holdNext('PUT', PUT_URL);
    const { result } = await renderList();

    const first = startToggle(result);
    await step(0);
    const complete = settle(result.current.completeList());
    await step(0);

    expect(methodJournal('POST')).toHaveLength(0);

    await act(async () => {
      releasePut(putRespond(200, '{"isPurchased":true}'));
      await Promise.all([first, complete]);
    });
  });

  it('complete vs row: a held completeList blocks a toggle of any row (no PUT)', async () => {
    const releasePost = holdNext('POST', HISTORY_URL);
    const { result } = await renderList();

    const complete = settle(result.current.completeList());
    await step(0);
    expect(methodJournal('POST')).toHaveLength(1);

    const toggle = settle(result.current.togglePurchased('item-2'));
    await step(0);
    expect(putJournal()).toHaveLength(0);

    await act(async () => {
      releasePost(putRespond(200, '{}'));
      await Promise.all([complete, toggle]);
    });
  });

  it('F1 closure: a row delivered while completeList POST is in flight is busy and blocked until Complete fails and unlocks', async () => {
    const dialogs = spyDialogs();
    const releasePost = holdNext('POST', HISTORY_URL);
    const { result } = await renderList();

    const complete = settle(result.current.completeList());
    await step(0);
    expect(methodJournal('POST')).toHaveLength(1);

    const lateItem: Item = {
      id: 'item-3',
      isPurchased: false,
      note: null,
      product: {
        id: 'prod-3',
        name: 'Сыр',
        emoji: '🧀',
        isCustom: false,
        imageUrl: null,
        category: { name: 'Молочные продукты', emoji: '🧀', order: 1 },
      },
      variant: null,
    };
    act(() => {
      queryClient.setQueryData<ListData>(queryKeys.list('list-1'), (old) =>
        old ? { ...old, items: [...old.items, lateItem] } : old
      );
    });

    expect(result.current.isItemBusy('item-3')).toBe(true);
    expect(result.current.isListBusy).toBe(true);

    await settle(result.current.togglePurchased('item-3'));
    await settle(result.current.updateNote('item-3', 'срочно'));
    await settle(result.current.removeItem('item-3'));
    await settle(result.current.clearAll());
    await settle(result.current.completeList());

    expect(putJournal()).toHaveLength(0);
    expect(methodJournal('DELETE')).toHaveLength(0);
    expect(methodJournal('POST')).toHaveLength(1);

    await act(async () => {
      releasePost(putRespond(500, 'boom'));
      await complete;
    });
    await step(0);

    expect(dialogs.alert).toHaveBeenCalledTimes(1);
    expect(result.current.isItemBusy('item-3')).toBe(false);
    expect(result.current.isItemBusy('item-1')).toBe(false);
    expect(result.current.isListBusy).toBe(false);

    enqueue('PUT', '/api/lists/list-1/items/item-3', [putRespond(200, '{"isPurchased":true}')]);
    await settle(result.current.togglePurchased('item-3'));
    expect(putJournal()).toHaveLength(1);
  });

  it('F1 closure: a row delivered while completeList POST is in flight unlocks when Complete succeeds', async () => {
    const releasePost = holdNext('POST', HISTORY_URL);
    const { result } = await renderList();

    const complete = settle(result.current.completeList());
    await step(0);

    const lateItem: Item = {
      id: 'item-3',
      isPurchased: false,
      note: null,
      product: {
        id: 'prod-3',
        name: 'Сыр',
        emoji: '🧀',
        isCustom: false,
        imageUrl: null,
        category: { name: 'Молочные продукты', emoji: '🧀', order: 1 },
      },
      variant: null,
    };
    act(() => {
      queryClient.setQueryData<ListData>(queryKeys.list('list-1'), (old) =>
        old ? { ...old, items: [...old.items, lateItem] } : old
      );
    });

    expect(result.current.isItemBusy('item-3')).toBe(true);

    await act(async () => {
      releasePost(putRespond(200, '{}'));
      await complete;
    });
    await step(0);

    expect(result.current.isItemBusy('item-3')).toBe(false);
    expect(result.current.isListBusy).toBe(false);
    expect(router.push).toHaveBeenCalledWith('/history');
  });

  it('completeList keeps the empty-list guard and sends no POST when items is empty', async () => {
    serverState = { ...serverState, items: [] };
    const { result } = await renderList();

    await settle(result.current.completeList());

    expect(methodJournal('POST')).toHaveLength(0);
    expect(result.current.isListBusy).toBe(false);
  });

  it('ACK refresh: a read that started before the write is not joined; the row reads again after it settles', async () => {
    enqueue('PUT', PUT_URL, [putRespond(200, '{"isPurchased":true}')]);
    const { result } = await renderList();
    // An ordinary read starts before the write and is held (the mount read has settled).
    const releaseOldRead = holdNext('GET', LIST_URL);
    void queryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    expect(getCount()).toBe(2);

    const done = startToggle(result);
    await step(0);
    expect(putJournal()).toHaveLength(1);
    // The ACK refresh waits for the held read; it does not return that read's result.
    expect(getCount()).toBe(2);

    releaseOldRead();
    await step(10_000);
    await done;
    expect(putJournal()).toHaveLength(1);
    // The row's own fresh read starts after the held one settles.
    expect(getCount()).toBe(3);
  });
});

describe('F3/F4/F5 regressions (AGE-1649)', () => {
  const makeExtraItem = (id: string, name: string): Item => ({
    id,
    isPurchased: false,
    note: null,
    product: {
      id: `prod-${id}`,
      name,
      emoji: '🧀',
      isCustom: false,
      imageUrl: null,
      category: { name: 'Молочные продукты', emoji: '🧀', order: 1 },
    },
    variant: null,
  });

  const retryOneClient = () =>
    new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0, staleTime: 5 * 60 * 1000 } },
    });

  it('F3: remount during held PUT keeps item-1 busy, blocks conflicting writes, keeps item-2 usable and unlocks on 200', async () => {
    const releasePut = holdNext('PUT', PUT_URL);
    enqueue('PUT', ITEM2_URL, [putRespond(200, '{"isPurchased":false}')]);
    const firstMount = await renderList();

    const pending = startToggle(firstMount.result);
    await step(0);
    expect(putJournal()).toHaveLength(1);

    firstMount.unmount();
    const remounted = renderHook(() => useShoppingListItems('list-1'), { wrapper });

    expect(remounted.result.current.isItemBusy('item-1')).toBe(true);
    expect(remounted.result.current.isListBusy).toBe(true);
    expect(remounted.result.current.isItemBusy('item-2')).toBe(false);

    await settle(remounted.result.current.togglePurchased('item-1'));
    await settle(remounted.result.current.removeItem('item-1'));
    await settle(remounted.result.current.updateNote('item-1', 'x'));
    await settle(remounted.result.current.clearAll());
    await settle(remounted.result.current.completeList());
    expect(putJournal()).toHaveLength(1);
    expect(methodJournal('DELETE')).toHaveLength(0);
    expect(methodJournal('POST')).toHaveLength(0);

    await settle(remounted.result.current.togglePurchased('item-2'));
    expect(
      journal.filter((entry) => entry.url === ITEM2_URL && entry.method === 'PUT')
    ).toHaveLength(1);

    await act(async () => {
      releasePut(putRespond(200, '{"isPurchased":true}'));
      await pending;
    });
    await step(0);

    expect(remounted.result.current.isItemBusy('item-1')).toBe(false);
    expect(remounted.result.current.isListBusy).toBe(false);

    enqueue('PUT', PUT_URL, [putRespond(200, '{"isPurchased":false}')]);
    await settle(remounted.result.current.togglePurchased('item-1'));
    expect(putJournal()).toHaveLength(3);
  });

  it('F3: remount during held required GET keeps item-1 busy, blocks conflicting writes and unlocks on reload error', async () => {
    const dialogs = spyDialogs();
    enqueue('PUT', PUT_URL, [putRespond(401, 'unauthorized')]);
    const firstMount = await renderList();
    const releaseReload = holdNext('GET', LIST_URL);

    const pending = startToggle(firstMount.result);
    await step(0);
    expect(getCount()).toBe(2);

    firstMount.unmount();
    const remounted = renderHook(() => useShoppingListItems('list-1'), { wrapper });

    expect(remounted.result.current.isItemBusy('item-1')).toBe(true);
    expect(remounted.result.current.isListBusy).toBe(true);
    expect(remounted.result.current.isItemBusy('item-2')).toBe(false);

    await settle(remounted.result.current.togglePurchased('item-1'));
    await settle(remounted.result.current.removeItem('item-1'));
    await settle(remounted.result.current.clearAll());
    await settle(remounted.result.current.completeList());
    expect(putJournal()).toHaveLength(1);
    expect(methodJournal('DELETE')).toHaveLength(0);
    expect(methodJournal('POST')).toHaveLength(0);

    await act(async () => {
      releaseReload(putRespond(500, 'boom'));
      await pending;
    });
    await step(0);

    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось обновить список');
    expect(remounted.result.current.isItemBusy('item-1')).toBe(false);
    expect(remounted.result.current.isListBusy).toBe(false);

    enqueue('PUT', PUT_URL, [putRespond(200, '{"isPurchased":true}')]);
    await settle(remounted.result.current.togglePurchased('item-1'));
    expect(putJournal()).toHaveLength(2);
  });

  it('F3: remount during held Complete keeps rows and list busy until Complete fails and succeeds', async () => {
    const dialogs = spyDialogs();
    const releaseFirstPost = holdNext('POST', HISTORY_URL);
    const firstMount = await renderList();

    const firstComplete = settle(firstMount.result.current.completeList());
    await step(0);
    expect(methodJournal('POST')).toHaveLength(1);

    firstMount.unmount();
    const remounted = renderHook(() => useShoppingListItems('list-1'), { wrapper });

    expect(remounted.result.current.isListBusy).toBe(true);
    expect(remounted.result.current.isItemBusy('item-1')).toBe(true);
    expect(remounted.result.current.isItemBusy('item-2')).toBe(true);

    await settle(remounted.result.current.completeList());
    await settle(remounted.result.current.togglePurchased('item-1'));
    await settle(remounted.result.current.removeItem('item-2'));
    await settle(remounted.result.current.updateNote('item-1', 'x'));
    await settle(remounted.result.current.clearAll());
    expect(methodJournal('POST')).toHaveLength(1);
    expect(putJournal()).toHaveLength(0);
    expect(methodJournal('DELETE')).toHaveLength(0);

    await act(async () => {
      releaseFirstPost(putRespond(500, 'boom'));
      await firstComplete;
    });
    await step(0);

    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось завершить список');
    expect(remounted.result.current.isListBusy).toBe(false);
    expect(remounted.result.current.isItemBusy('item-1')).toBe(false);

    const releaseSecondPost = holdNext('POST', HISTORY_URL);
    const secondComplete = settle(remounted.result.current.completeList());
    await step(0);
    expect(methodJournal('POST')).toHaveLength(2);

    remounted.unmount();
    const thirdMount = renderHook(() => useShoppingListItems('list-1'), { wrapper });
    expect(thirdMount.result.current.isListBusy).toBe(true);
    expect(thirdMount.result.current.isItemBusy('item-1')).toBe(true);

    await act(async () => {
      releaseSecondPost(putRespond(200, '{}'));
      await secondComplete;
    });
    await step(0);

    expect(thirdMount.result.current.isListBusy).toBe(false);
    expect(thirdMount.result.current.isItemBusy('item-1')).toBe(false);
  });

  it('F3 isolation: lock on list-1 does not block list-2 in same QueryClient or list-1 in another QueryClient', async () => {
    const releaseList1Put = holdNext('PUT', PUT_URL);
    enqueue('GET', '/api/lists/list-2', [
      putRespond(200, JSON.stringify({ ...makeListData(), id: 'list-2' })),
    ]);
    enqueue('PUT', '/api/lists/list-2/items/item-1', [putRespond(200, '{"isPurchased":true}')]);

    const list1 = await renderList();
    const pendingList1 = startToggle(list1.result);
    await step(0);

    const list2 = renderHook(() => useShoppingListItems('list-2'), { wrapper });
    await step(0);
    expect(list2.result.current.isListBusy).toBe(false);
    expect(list2.result.current.isItemBusy('item-1')).toBe(false);

    await settle(list2.result.current.togglePurchased('item-1'));
    expect(
      journal.filter(
        (entry) => entry.url === '/api/lists/list-2/items/item-1' && entry.method === 'PUT'
      )
    ).toHaveLength(1);

    const otherClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } },
    });
    const otherWrapper = ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
        <QueryClientProvider client={otherClient}>{children}</QueryClientProvider>
      </NextIntlClientProvider>
    );
    enqueue('PUT', PUT_URL, [putRespond(200, '{"isPurchased":true}')]);
    const otherList1 = renderHook(() => useShoppingListItems('list-1'), { wrapper: otherWrapper });
    await step(0);
    expect(otherList1.result.current.isListBusy).toBe(false);
    expect(otherList1.result.current.isItemBusy('item-1')).toBe(false);

    await settle(otherList1.result.current.togglePurchased('item-1'));
    expect(journal.filter((entry) => entry.url === PUT_URL && entry.method === 'PUT')).toHaveLength(
      2
    );
    otherClient.clear();

    await act(async () => {
      releaseList1Put(putRespond(200, '{"isPurchased":true}'));
      await pendingList1;
    });
  });

  it('F4: refreshAfterWrite waits for a paused list retryer without cancelling it, then runs a fresh read', async () => {
    queryClient = retryOneClient();
    const { result } = await renderList();
    const releasePut = holdNext('PUT', PUT_URL);
    const toggleDone = startToggle(result);
    await step(0);
    expect(putJournal()).toHaveLength(1);

    const releaseOldGet = holdNext('GET', LIST_URL);
    void queryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    expect(getCount()).toBe(2);

    act(() => onlineManager.setOnline(false));
    await act(async () => {
      releaseOldGet(putRespond(500, 'temp error'));
      await Promise.resolve();
    });
    await step(0);

    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.list('list-1') });
    expect(query?.state.fetchStatus).toBe('paused');

    const staleSnapshot = JSON.stringify(serverState);
    const releaseResumedRetry = holdNext('GET', LIST_URL);
    await act(async () => {
      releasePut(putRespond(200, '{"isPurchased":true}'));
      await Promise.resolve();
    });
    await step(1);

    // Paused old cycle was not cancelled; refreshAfterWrite waits for it before unlocking.
    expect(getCount()).toBe(2);
    expect(result.current.isItemBusy('item-1')).toBe(true);

    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
    });
    await step(0);
    expect(getCount()).toBe(3);

    setServerItem('item-1', { note: SERVER_NOTE });
    releaseResumedRetry(putRespond(200, staleSnapshot));
    await step(1);
    await toggleDone;
    await step(1);

    // 1 mount + 1 failed initial + 1 stale resumed retry + 1 fresh follow-up read.
    expect(getCount()).toBe(4);
    expect(currentItem('item-1').note).toBe(SERVER_NOTE);
    expect(result.current.isItemBusy('item-1')).toBe(false);
  });

  it.each([200, 404] as const)(
    'F5: single removeItem (%s) keeps item removed when follow-up reload fails with retry 1',
    async (status) => {
      const dialogs = spyDialogs();
      queryClient = retryOneClient();
      const { result } = await renderList();
      enqueue('DELETE', PUT_URL, [putRespond(status, status === 404 ? 'gone' : '{}')]);
      enqueue('GET', LIST_URL, [putRespond(500, 'boom'), putRespond(500, 'boom')]);

      const done = settle(result.current.removeItem('item-1'));
      await step(0);
      await step(0);
      await done;

      expect(hasItem('item-1')).toBe(false);
      expect(hasItem('item-2')).toBe(true);
      expect(getCount()).toBe(3);
      expect(rollbackCount()).toBe(0);
      expect(dialogs.alert).not.toHaveBeenCalled();
      expect(result.current.isItemBusy('item-1')).toBe(false);
    }
  );

  it('F5: single updateNote (200) keeps saved note when follow-up reload fails with retry 1', async () => {
    const dialogs = spyDialogs();
    queryClient = retryOneClient();
    const { result } = await renderList();
    enqueue('PUT', PUT_URL, [putRespond(200, '{"note":"срочно"}')]);
    enqueue('GET', LIST_URL, [putRespond(500, 'boom'), putRespond(500, 'boom')]);

    const done = settle(result.current.updateNote('item-1', 'срочно'));
    await step(0);
    await step(0);
    await done;

    expect(currentItem('item-1').note).toBe('срочно');
    expect(getCount()).toBe(3);
    expect(rollbackCount()).toBe(0);
    expect(dialogs.alert).not.toHaveBeenCalled();
    expect(result.current.isItemBusy('item-1')).toBe(false);
  });

  it('F5: partial clearAll [A,B,C] (A 200, B 500) keeps A removed and B,C visible when reload fails with retry 1', async () => {
    const dialogs = spyDialogs();
    queryClient = retryOneClient();
    serverState = {
      ...serverState,
      items: [...serverState.items, makeExtraItem('item-3', 'Сыр')],
    };
    const { result } = await renderList();
    enqueue('DELETE', PUT_URL, [putRespond(200, '{}')]);
    enqueue('DELETE', ITEM2_URL, [putRespond(500, 'boom')]);
    enqueue('GET', LIST_URL, [putRespond(500, 'boom'), putRespond(500, 'boom')]);

    const done = settle(result.current.clearAll());
    await step(0);
    await step(0);
    await done;

    expect(deleteUrls()).toEqual([PUT_URL, ITEM2_URL]);
    expect(getCount()).toBe(3);
    expect(hasItem('item-1')).toBe(false);
    expect(hasItem('item-2')).toBe(true);
    expect(hasItem('item-3')).toBe(true);
    expect(rollbackCount()).toBe(0);
    expect(dialogs.error).toHaveBeenCalledTimes(1);
    expect(dialogs.alert).toHaveBeenCalledTimes(1);
    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось обновить список');
    expect(result.current.isListBusy).toBe(false);
  });

  it('F5: failed single DELETE keeps row visible when terminal reload also fails with retry 1', async () => {
    const dialogs = spyDialogs();
    queryClient = retryOneClient();
    const { result } = await renderList();
    enqueue('DELETE', PUT_URL, [putRespond(500, 'boom')]);
    enqueue('GET', LIST_URL, [putRespond(500, 'boom'), putRespond(500, 'boom')]);

    const done = settle(result.current.removeItem('item-1'));
    await step(0);
    await step(0);
    await done;
    await step(1);

    expect(hasItem('item-1')).toBe(true);
    expect(getCount()).toBe(3);
    expect(dialogs.error).toHaveBeenCalledTimes(1);
    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось обновить список');
    expect(result.current.isItemBusy('item-1')).toBe(false);
  });

  it('F5: a held pre-ACK GET settling with stale data does not erase ACK when the fresh reload fails (remove, note, partial batch)', async () => {
    const dialogs = spyDialogs();
    queryClient = retryOneClient();
    const { result } = await renderList();

    // 1) removeItem with held pre-ACK GET
    const releaseOldGet1 = holdNext('GET', LIST_URL);
    void queryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    expect(getCount()).toBe(2);

    enqueue('DELETE', PUT_URL, [putRespond(200, '{}')]);
    enqueue('GET', LIST_URL, [putRespond(500, 'boom'), putRespond(500, 'boom')]);
    const removeDone = settle(result.current.removeItem('item-1'));
    await step(0);

    // Pre-ACK GET still returns item-1; fresh GET fails twice.
    releaseOldGet1(putRespond(200, JSON.stringify(makeListData())));
    await step(0);
    await removeDone;

    expect(hasItem('item-1')).toBe(false);
    expect(hasItem('item-2')).toBe(true);
    expect(getCount()).toBe(4);

    // 2) updateNote on item-2 with held pre-ACK GET
    const releaseOldGet2 = holdNext('GET', LIST_URL);
    void queryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    expect(getCount()).toBe(5);

    enqueue('PUT', ITEM2_URL, [putRespond(200, '{"note":"без корочки"}')]);
    enqueue('GET', LIST_URL, [putRespond(500, 'boom'), putRespond(500, 'boom')]);
    const noteDone = settle(result.current.updateNote('item-2', 'без корочки'));
    await step(0);

    releaseOldGet2(
      putRespond(
        200,
        JSON.stringify({ id: 'list-1', name: 'Список', items: [makeListData().items[1]] })
      )
    );
    await step(0);
    await noteDone;

    expect(currentItem('item-2').note).toBe('без корочки');
    expect(getCount()).toBe(7);

    // 3) partial clearAll [item-2, item-3] with held pre-ACK GET
    const item3 = makeExtraItem('item-3', 'Сыр');
    act(() => {
      queryClient.setQueryData<ListData>(queryKeys.list('list-1'), (old) =>
        old ? { ...old, items: [...old.items, item3] } : old
      );
    });
    const staleBeforeBatch = {
      id: 'list-1',
      name: 'Список',
      items: [makeListData().items[1], item3],
    };
    const releaseOldGet3 = holdNext('GET', LIST_URL);
    void queryClient.invalidateQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    expect(getCount()).toBe(8);

    enqueue('DELETE', ITEM2_URL, [putRespond(200, '{}')]);
    enqueue('DELETE', '/api/lists/list-1/items/item-3', [putRespond(500, 'boom')]);
    enqueue('GET', LIST_URL, [putRespond(500, 'boom'), putRespond(500, 'boom')]);
    const clearDone = settle(result.current.clearAll());
    await step(0);

    releaseOldGet3(putRespond(200, JSON.stringify(staleBeforeBatch)));
    await step(0);
    await clearDone;

    expect(hasItem('item-2')).toBe(false);
    expect(hasItem('item-3')).toBe(true);
    expect(getCount()).toBe(10);
    expect(dialogs.alert).toHaveBeenCalledTimes(1);
    expect(dialogs.alert).toHaveBeenCalledWith('Не удалось обновить список');
  });
});
