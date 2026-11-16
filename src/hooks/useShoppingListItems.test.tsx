import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import ShoppingListItem from '@/components/shopping/ShoppingListItem';
import Providers from '@/components/Providers';
import ShoppingListPage from '@/app/lists/[listId]/page';
import { useSession } from 'next-auth/react';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
  useQueryClient,
} from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { messages } from '@/i18n/messages';
import { queryKeys } from '@/lib/query-keys';
import { useShoppingListItems, type ListData } from './useShoppingListItems';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/components/ProductSearch', () => ({ default: () => null }));

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
  | { kind: 'deferred'; response: Promise<Response> };

const LIST_URL = '/api/lists/list-1';
const PUT_URL = '/api/lists/list-1/items/item-1';

let sessionResponse: object;
let sessionUpdate: Promise<Response> | undefined;
let serverState: ListData;
let journal: JournalEntry[];
let active: Map<string, number>;
let maxActive: Map<string, number>;
let releasePending: Array<() => void>;
let queues: Map<string, Queued[]>;
let queryClient: QueryClient;
let rollbackWitness: ListData | undefined;
let setQueryDataSpy: ReturnType<typeof vi.spyOn>;
let invalidateSpy: ReturnType<typeof vi.spyOn>;

const key = (method: string, url: string) => `${method} ${url}`;

function enqueue(method: string, url: string, queued: Queued[]) {
  queues.set(key(method, url), [...(queues.get(key(method, url)) ?? []), ...queued]);
}

const putReject = (): Queued => ({ kind: 'reject', error: new TypeError('fetch failed') });
const putRespond = (status: number, body: string | null): Queued => ({
  kind: 'respond',
  status,
  body,
});

const putJournal = () => journal.filter((entry) => entry.method === 'PUT');

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
      if (url.endsWith('/api/auth/csrf')) return Response.json({ csrfToken: 'test-token' });
      if (url.endsWith('/api/auth/session')) {
        if (method === 'POST' && sessionUpdate) return await sessionUpdate;
        return Response.json(sessionResponse);
      }
      journal.push({ method, url, body });

      if (method === 'PUT') {
        const count = (active.get(url) ?? 0) + 1;
        active.set(url, count);
        maxActive.set(url, Math.max(maxActive.get(url) ?? 0, count));
      }
      try {
        const next = queues.get(key(method, url))?.shift();
        if (next?.kind === 'deferred') {
          const cleanup = new Promise<Response>((resolve) => {
            releasePending.push(() => resolve(new Response(null, { status: 499 })));
          });
          const response = await Promise.race([next.response, cleanup]);
          if (
            method === 'PUT' &&
            response.status >= 200 &&
            response.status < 300 &&
            body &&
            typeof body === 'object'
          ) {
            const itemId = /\/items\/([^/]+)$/.exec(url)?.[1];
            const patch = body as { isPurchased?: unknown };
            if (itemId && typeof patch.isPurchased === 'boolean') {
              const isPurchased = patch.isPurchased;
              serverState = {
                ...serverState,
                items: serverState.items.map((item) =>
                  item.id === itemId ? { ...item, isPurchased } : item
                ),
              };
            }
          }
          return response;
        }
        if (next?.kind === 'reject') {
          throw next.error;
        }
        if (next?.kind === 'respond') {
          if (
            method === 'PUT' &&
            next.status >= 200 &&
            next.status < 300 &&
            body &&
            typeof body === 'object'
          ) {
            const itemId = /\/items\/([^/]+)$/.exec(url)?.[1];
            const patch = body as { isPurchased?: unknown };
            if (itemId && typeof patch.isPurchased === 'boolean') {
              const isPurchased = patch.isPurchased;
              serverState = {
                ...serverState,
                items: serverState.items.map((item) =>
                  item.id === itemId ? { ...item, isPurchased } : item
                ),
              };
            }
          }
          return new Response(next.body, { status: next.status });
        }
        if (method === 'GET') {
          return new Response(JSON.stringify(serverState), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      } finally {
        if (method === 'PUT') active.set(url, (active.get(url) ?? 1) - 1);
      }
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

async function renderProviderList() {
  const rendered = renderHook(
    () => {
      const client = useQueryClient();
      return { client, ...useShoppingListItems('list-1') };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      ),
    }
  );
  queryClient = rendered.result.current.client;
  setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  await step(10);
  rollbackWitness = queryClient.getQueryData<ListData>(queryKeys.list('list-1'));
  return rendered;
}

function startToggle(result: { current: { togglePurchased: (itemId: string) => Promise<void> } }) {
  return result.current.togglePurchased('item-1').catch((error: unknown) => error);
}

function currentItem(itemId = 'item-1') {
  const data = queryClient.getQueryData<ListData>(queryKeys.list('list-1'));
  const item = data?.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`item ${itemId} not in cache`);
  return item;
}

const rollbackCount = () =>
  setQueryDataSpy.mock.calls.filter((call: unknown) => {
    const [queryKey, value] = call as [readonly unknown[], unknown];
    return Array.isArray(queryKey) && queryKey[0] === 'list' && value === rollbackWitness;
  }).length;

beforeEach(() => {
  vi.useFakeTimers();
  sessionResponse = { user: { id: 'user-a', name: 'A' }, expires: '2099-01-01T00:00:00.000Z' };
  sessionUpdate = undefined;
  serverState = makeListData();
  journal = [];
  active = new Map();
  maxActive = new Map();
  releasePending = [];
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
  for (const release of releasePending) release();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe('togglePurchased retry/ACK contract (N1)', () => {
  it('AC-1: four transport rejects keep the optimistic value, then retains the exhausted intent after the 4th attempt', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    const { result } = await renderList();
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
    expect(currentItem().isPurchased).toBe(true);
    expect(rollbackCount()).toBe(0);

    await done;
    for (const entry of putJournal()) {
      expect(entry.body).toEqual({ isPurchased: true });
    }
    expect(currentItem().isPurchased).toBe(true);
    expect(rollbackCount()).toBe(0);

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
      expect.objectContaining({ queryKey: queryKeys.list('list-1') })
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
      expect.objectContaining({ queryKey: queryKeys.list('list-1') })
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
    'AC-4 retryable: $name exhausts the budget of 4 PUTs, then retains the exhausted intent',
    async ({ queued }) => {
      enqueue('PUT', PUT_URL, [queued(), queued(), queued(), queued()]);
      const { result } = await renderList();
      const done = startToggle(result);

      await step(0);
      await step(1000);
      await step(2000);
      await step(4000);
      await step(10_000);

      expect(putJournal()).toHaveLength(4);
      expect(currentItem().isPurchased).toBe(true);
      expect(rollbackCount()).toBe(0);

      await done;

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
    'AC-4 permanent: $name yields exactly one PUT, no retry, own-item baseline rollback',
    async ({ status }) => {
      enqueue('PUT', PUT_URL, [putRespond(status, 'error')]);
      const { result } = await renderList();
      const done = startToggle(result);

      await step(0);
      await step(10_000);

      expect(putJournal()).toHaveLength(1);
      expect(currentItem().isPurchased).toBe(false);
      expect(rollbackCount()).toBe(0);

      await done;

      expect(putJournal()).toHaveLength(1);
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
        expect.objectContaining({ queryKey: queryKeys.list('list-1') })
      );

      await done;
    }
  );

  it('AC-5: first reject pauses offline during backoff; online resumes the same cycle with the remaining budget', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    const { result } = await renderList();
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
    expect(currentItem().isPurchased).toBe(true);
    expect(rollbackCount()).toBe(0);

    await done;
    expect(putJournal()).toHaveLength(4);
    expect(rollbackCount()).toBe(0);
    expect(currentItem().isPurchased).toBe(true);
  });

  it.each([
    { name: 'transport reject then HTTP 401', second: () => putRespond(401, 'unauthorized') },
    { name: 'transport reject then HTTP 302', second: () => putRespond(302, 'redirect') },
  ])(
    'FR-1 neighbor: $name — exactly two PUTs with the same body, own-item terminal rollback, no extra PUT',
    async ({ second }) => {
      enqueue('PUT', PUT_URL, [putReject(), second()]);
      const { result } = await renderList();
      const done = startToggle(result);

      await step(0);
      await step(1000);
      await step(10_000);

      expect(putJournal()).toHaveLength(2);
      for (const entry of putJournal()) {
        expect(entry.body).toEqual({ isPurchased: true });
      }
      expect(currentItem().isPurchased).toBe(false);
      expect(rollbackCount()).toBe(0);

      await done;
      expect(putJournal()).toHaveLength(2);
    }
  );
});

describe('purchase intent contract (AGE-1646)', () => {
  it.each([2, 3, 4])(
    'F8: already-started attempt #%i settles before the next revision starts',
    async (attempt) => {
      let release!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        release = resolve;
      });
      enqueue('PUT', PUT_URL, [
        ...Array.from({ length: attempt - 1 }, () => putRespond(500, '{}')),
        { kind: 'deferred', response },
        putRespond(200, '{}'),
      ]);
      const { result } = await renderList();
      void startToggle(result);
      await step(0);
      for (const delay of [1000, 2000, 4000].slice(0, attempt - 1)) await step(delay);
      expect(putJournal()).toHaveLength(attempt);
      void startToggle(result);
      await step(0);
      expect(currentItem().isPurchased).toBe(false);
      expect(putJournal()).toHaveLength(attempt);
      release(new Response('{}', { status: 500 }));
      await step(0);
      expect(putJournal().map((entry) => entry.body)).toEqual([
        ...Array.from({ length: attempt }, () => ({ isPurchased: true })),
        { isPurchased: false },
      ]);
      await step(10_000);
      expect(putJournal()).toHaveLength(attempt + 1);
    }
  );

  it('F1: exhausted transport retains the desired value without further PUTs', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    const { result } = await renderList();
    const done = startToggle(result);
    await step(0);
    await step(1000);
    await step(2000);
    await step(4000);
    await done;
    expect(putJournal()).toHaveLength(4);
    expect(currentItem().isPurchased).toBe(true);
    await step(10_000);
    expect(putJournal()).toHaveLength(4);
  });

  it('F4: two synchronous taps send distinct absolute values in FIFO order', async () => {
    enqueue('PUT', PUT_URL, [putRespond(200, '{}'), putRespond(200, '{}')]);
    const { result } = await renderList();
    act(() => {
      void startToggle(result);
      void startToggle(result);
    });
    await step(0);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      { isPurchased: true },
      { isPurchased: false },
    ]);
  });

  it('F7: 205 with an empty body acknowledges the PUT', async () => {
    enqueue('PUT', PUT_URL, [putRespond(205, null)]);
    const { result } = await renderList();
    const done = startToggle(result);
    await step(0);
    await done;
    expect(putJournal()).toHaveLength(1);
    expect(currentItem().isPurchased).toBe(true);
    expect(rollbackCount()).toBe(0);
    await step(10_000);
    expect(putJournal()).toHaveLength(1);
  });
});

describe('purchase intent independent checkpoints', () => {
  function deferred() {
    let release!: (value: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    return { response, release };
  }

  const bodies = (url = PUT_URL) =>
    putJournal()
      .filter((entry) => entry.url === url)
      .map((entry) => entry.body);
  const toggle = (
    result: { current: { togglePurchased: (id: string) => Promise<void> } },
    id: string
  ) => {
    void result.current.togglePurchased(id).catch(() => {});
  };

  it('M-parallel: same item stays serial while a different item starts', async () => {
    const first = deferred();
    const secondItem = deferred();
    const otherUrl = '/api/lists/list-1/items/item-2';
    enqueue('PUT', PUT_URL, [
      { kind: 'deferred', response: first.response },
      putRespond(200, '{}'),
      putRespond(200, '{}'),
    ]);
    enqueue('PUT', otherUrl, [{ kind: 'deferred', response: secondItem.response }]);
    const { result } = await renderList();
    toggle(result, 'item-1');
    await step(0);
    toggle(result, 'item-1');
    await step(0);
    toggle(result, 'item-1');
    toggle(result, 'item-2');
    await step(0);
    expect(bodies(otherUrl)).toEqual([{ isPurchased: false }]);
    expect(maxActive.get(PUT_URL)).toBe(1);
    expect(bodies()).toEqual([{ isPurchased: true }]);
    expect(active.get(PUT_URL)).toBe(1);
    expect(active.get(otherUrl)).toBe(1);
    first.release(new Response('{}', { status: 200 }));
    secondItem.release(new Response('{}', { status: 200 }));
    await step(0);
  });

  it('M-coalesce: ABA retains each queued first attempt', async () => {
    const first = deferred();
    const second = deferred();
    enqueue('PUT', PUT_URL, [
      { kind: 'deferred', response: first.response },
      { kind: 'deferred', response: second.response },
      putRespond(200, '{}'),
    ]);
    const { result } = await renderList();
    toggle(result, 'item-1');
    await step(0);
    toggle(result, 'item-1');
    await step(0);
    toggle(result, 'item-1');
    await step(0);
    first.release(new Response('{}', { status: 200 }));
    await step(0);
    expect(bodies()).toEqual([{ isPurchased: true }, { isPurchased: false }]);
    expect(active.get(PUT_URL)).toBe(1);
    second.release(new Response('{}', { status: 200 }));
    await step(0);
    expect(bodies()).toEqual([
      { isPurchased: true },
      { isPurchased: false },
      { isPurchased: true },
    ]);
  });

  it('M-late-retry: superseded backoff cannot send another old PUT', async () => {
    enqueue('PUT', PUT_URL, [putRespond(500, '{}'), putRespond(200, '{}'), putRespond(200, '{}')]);
    const { result } = await renderList();
    toggle(result, 'item-1');
    await step(0);
    toggle(result, 'item-1');
    await step(0);
    expect(bodies()).toEqual([{ isPurchased: true }, { isPurchased: false }]);
    await step(10_000);
    expect(bodies()).toEqual([{ isPurchased: true }, { isPurchased: false }]);
    expect(currentItem().isPurchased).toBe(false);
  });

  it('F4: offline queued first attempts retain true then false', async () => {
    enqueue('PUT', PUT_URL, [putRespond(200, '{}'), putRespond(200, '{}')]);
    const { result } = await renderList();
    act(() => onlineManager.setOnline(false));
    toggle(result, 'item-1');
    await step(0);
    toggle(result, 'item-1');
    await step(0);
    expect(bodies()).toEqual([]);
    act(() => onlineManager.setOnline(true));
    await step(0);
    expect(bodies()).toEqual([{ isPurchased: true }, { isPurchased: false }]);
  });

  it('F5: permanent failure restores only the item and preserves a changed sibling', async () => {
    const first = deferred();
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response: first.response }]);
    const { result } = await renderList();
    toggle(result, 'item-1');
    await step(0);
    queryClient.setQueryData<ListData>(
      queryKeys.list('list-1'),
      (old) =>
        old && {
          ...old,
          items: old.items.map((item) =>
            item.id === 'item-2' ? { ...item, note: 'changed' } : item
          ),
        }
    );
    const read = deferred();
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: read.response }]);
    first.release(new Response('denied', { status: 401 }));
    await step(0);
    expect(currentItem().isPurchased).toBe(false);
    expect(currentItem('item-2').note).toBe('changed');
    expect(bodies()).toHaveLength(1);
    read.release(new Response(JSON.stringify(serverState), { status: 200 }));
  });

  it('F5: permanent failure cannot resurrect a deleted row', async () => {
    const first = deferred();
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response: first.response }]);
    const { result } = await renderList();
    toggle(result, 'item-1');
    await step(0);
    queryClient.setQueryData<ListData>(
      queryKeys.list('list-1'),
      (old) => old && { ...old, items: old.items.filter((item) => item.id !== 'item-1') }
    );
    const read = deferred();
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: read.response }]);
    first.release(new Response('denied', { status: 401 }));
    await step(0);
    expect(
      queryClient.getQueryData<ListData>(queryKeys.list('list-1'))?.items.map((item) => item.id)
    ).toEqual(['item-2']);
    expect(bodies()).toHaveLength(1);
    read.release(new Response(JSON.stringify(serverState), { status: 200 }));
  });
});

describe('purchase intent delivery fences', () => {
  it('F3: exhausted revision re-arms once on a real online edge', async () => {
    enqueue('PUT', PUT_URL, [
      putReject(),
      putReject(),
      putReject(),
      putReject(),
      putRespond(200, '{}'),
    ]);
    const first = await renderProviderList();
    void startToggle(first.result);
    await step(0);
    await step(1000);
    await step(2000);
    await step(4000);
    expect(putJournal()).toHaveLength(4);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(0);
    expect(putJournal()).toHaveLength(5);
    expect(putJournal()[4].body).toEqual({ isPurchased: true });
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal()).toHaveLength(5);
    first.unmount();
  });

  it('F3 control: native pause resumes remaining second attempt and ACKs', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putRespond(200, '{}')]);
    const { result } = await renderProviderList();
    const done = startToggle(result);
    await step(0);
    act(() => onlineManager.setOnline(false));
    await step(1000);
    expect(putJournal()).toHaveLength(1);
    act(() => onlineManager.setOnline(true));
    await step(0);
    await done;
    expect(putJournal()).toHaveLength(2);
    expect(currentItem().isPurchased).toBe(true);
    await step(10_000);
    expect(putJournal()).toHaveLength(2);
  });

  it('F8: re-armed started attempt settles before a new first attempt', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    enqueue('PUT', PUT_URL, [
      putReject(),
      putReject(),
      putReject(),
      putReject(),
      { kind: 'deferred', response },
      putRespond(200, '{}'),
    ]);
    const { result } = await renderProviderList();
    void startToggle(result);
    await step(0);
    await step(1000);
    await step(2000);
    await step(4000);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(0);
    expect(putJournal()).toHaveLength(5);
    void startToggle(result);
    await step(0);
    expect(currentItem().isPurchased).toBe(false);
    expect(putJournal()).toHaveLength(5);
    expect(maxActive.get(PUT_URL)).toBe(1);
    release(new Response('{}', { status: 500 }));
    await step(0);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      ...Array.from({ length: 5 }, () => ({ isPurchased: true })),
      { isPurchased: false },
    ]);
    await step(10_000);
    expect(putJournal()).toHaveLength(6);
  });
});

describe('purchase intent read handoff', () => {
  it('F2: a canceled pre-ACK GET and failed post-ACK GET do not remove the overlay', async () => {
    let releaseRead!: (response: Response) => void;
    let releasePut!: (response: Response) => void;
    const read = new Promise<Response>((resolve) => {
      releaseRead = resolve;
    });
    const put = new Promise<Response>((resolve) => {
      releasePut = resolve;
    });
    const { result } = await renderList();
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: read }, putRespond(500, 'error')]);
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response: put }]);
    void queryClient.refetchQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    void startToggle(result);
    await step(0);
    releasePut(new Response('{}', { status: 200 }));
    await step(0);
    releaseRead(new Response(JSON.stringify(makeListData()), { status: 200 }));
    await step(0);
    expect(currentItem().isPurchased).toBe(true);
    expect(putJournal()).toHaveLength(1);
  });

  it('F2: applied post-ACK GET hands off the item and new fields without another PUT', async () => {
    enqueue('PUT', PUT_URL, [putRespond(200, '{}')]);
    const { result } = await renderList();
    const done = startToggle(result);
    await step(0);
    await done;
    const next = makeListData();
    next.items[0].note = 'fresh';
    enqueue('GET', LIST_URL, [putRespond(200, JSON.stringify(next))]);
    void queryClient.refetchQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    expect(currentItem().isPurchased).toBe(false);
    expect(currentItem().note).toBe('fresh');
    expect(putJournal()).toHaveLength(1);
  });
});

describe('purchase intent UI', () => {
  it('F1: the real toggle remains pressed and focused after exhaustion', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    function ItemView() {
      const { items, togglePurchased } = useShoppingListItems('list-1');
      const item = items.find((candidate) => candidate.id === 'item-1');
      return item ? (
        <ShoppingListItem
          item={item}
          onRemove={() => {}}
          onToggle={(id) => {
            void togglePurchased(id).catch(() => {});
          }}
        />
      ) : null;
    }
    render(<ItemView />, { wrapper });
    await step(0);
    const button = screen.getByRole('button', { pressed: false, name: /Молоко/ });
    button.focus();
    fireEvent.click(button);
    await step(0);
    await step(1000);
    await step(2000);
    await step(4000);
    await step(10);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(button);
    expect(putJournal()).toHaveLength(4);
  });
});

describe('purchase intent session owner', () => {
  it('F6: logout with no hook consumers fences a paused retry', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putRespond(200, '{}')]);
    function Consumer() {
      const { items, togglePurchased } = useShoppingListItems('list-1');
      return (
        <button
          onClick={() => {
            void togglePurchased('item-1').catch(() => {});
          }}
        >
          {items.length ? 'ready' : 'loading'}
        </button>
      );
    }
    function SessionWitness() {
      const { status } = useSession();
      return <span data-testid="session-status">{status}</span>;
    }
    function Tree({ visible }: { visible: boolean }) {
      return (
        <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
          <Providers>
            <SessionWitness />
            {visible && <Consumer />}
          </Providers>
        </NextIntlClientProvider>
      );
    }
    const view = render(<Tree visible />);
    await step(10);
    expect(screen.getByRole('button').textContent).toBe('ready');
    expect(screen.getByTestId('session-status').textContent).toBe('authenticated');
    fireEvent.click(screen.getByRole('button'));
    await step(0);
    expect(putJournal()).toHaveLength(1);
    act(() => onlineManager.setOnline(false));
    view.rerender(<Tree visible={false} />);
    sessionResponse = {};
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await step(1000);
    expect(screen.getByTestId('session-status').textContent).toBe('unauthenticated');
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal()).toHaveLength(1);
  });
});

describe('purchase intent baseline ownership', () => {
  it('F5: an older sent ACK changes rollback baseline without changing the newer overlay', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response }, putRespond(401, 'denied')]);
    const rendered = await renderList();
    const { result } = rendered;
    void startToggle(result);
    await step(0);
    void startToggle(result);
    await step(0);
    expect(currentItem().isPurchased).toBe(false);
    const heldRead = new Promise<Response>(() => {});
    enqueue('GET', LIST_URL, [
      { kind: 'deferred', response: heldRead },
      { kind: 'deferred', response: heldRead },
    ]);
    release(new Response('{}', { status: 200 }));
    await step(0);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      { isPurchased: true },
      { isPurchased: false },
    ]);
    expect(currentItem().isPurchased).toBe(true);
    expect(currentItem('item-2').isPurchased).toBe(true);
    await step(10_000);
    expect(putJournal()).toHaveLength(2);
  });

  it('F5: a fresh applied GET changes baseline used by a later permanent failure', async () => {
    enqueue('PUT', PUT_URL, [putRespond(200, '{}'), putRespond(401, 'denied')]);
    const { result } = await renderList();
    const first = startToggle(result);
    await step(0);
    await first;
    const fresh = makeListData();
    fresh.items[0].note = 'fresh note';
    serverState = fresh;
    void queryClient.refetchQueries({ queryKey: queryKeys.list('list-1') });
    await step(10);
    expect(currentItem().isPurchased).toBe(false);
    expect(currentItem().note).toBe('fresh note');
    void startToggle(result);
    await step(10);
    expect(currentItem().isPurchased).toBe(false);
    expect(currentItem().note).toBe('fresh note');
    expect(putJournal()).toHaveLength(2);
  });
});

describe('purchase intent repeated online edges', () => {
  it('F3: a second exhausted cycle needs a second offline-to-online edge', async () => {
    enqueue('PUT', PUT_URL, [
      ...Array.from({ length: 8 }, () => putRespond(500, '{}')),
      putRespond(200, '{}'),
    ]);
    const { result } = await renderProviderList();
    void startToggle(result);
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    expect(putJournal()).toHaveLength(4);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    expect(putJournal()).toHaveLength(8);
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal()).toHaveLength(8);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(0);
    expect(putJournal()).toHaveLength(9);
    await step(10_000);
    expect(putJournal()).toHaveLength(9);
  });

  it('F3 control: explicit resumePausedMutations continues the same budget', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putRespond(200, '{}')]);
    const { result } = await renderProviderList();
    const done = startToggle(result);
    await step(0);
    act(() => onlineManager.setOnline(false));
    await step(1000);
    expect(putJournal()).toHaveLength(1);
    act(() => onlineManager.setOnline(true));
    void queryClient.resumePausedMutations();
    await step(0);
    await done;
    expect(putJournal()).toHaveLength(2);
    expect(currentItem().isPurchased).toBe(true);
    await step(10_000);
    expect(putJournal()).toHaveLength(2);
  });
});

describe('purchase intent session settle', () => {
  it('F6: old permanent settle cannot overwrite a new session cache at zero consumers', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response }]);
    let client!: QueryClient;
    function Witness() {
      client = useQueryClient();
      const { status } = useSession();
      return <span data-testid="session-state">{status}</span>;
    }
    function Consumer() {
      const { items, togglePurchased } = useShoppingListItems('list-1');
      return (
        <button
          onClick={() => {
            void togglePurchased('item-1').catch(() => {});
          }}
        >
          {items.length ? 'ready' : 'loading'}
        </button>
      );
    }
    function Tree({ visible }: { visible: boolean }) {
      return (
        <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
          <Providers>
            <Witness />
            {visible && <Consumer />}
          </Providers>
        </NextIntlClientProvider>
      );
    }
    const view = render(<Tree visible />);
    await step(10);
    expect(screen.getByTestId('session-state').textContent).toBe('authenticated');
    expect(screen.getByRole('button').textContent).toBe('ready');
    fireEvent.click(screen.getByRole('button'));
    await step(0);
    expect(putJournal()).toHaveLength(1);
    view.rerender(<Tree visible={false} />);
    sessionResponse = {};
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await step(10);
    expect(screen.getByTestId('session-state').textContent).toBe('unauthenticated');
    const replacement = makeListData();
    replacement.items[0].note = 'new session';
    client.setQueryData(queryKeys.list('list-1'), replacement);
    release(new Response('denied', { status: 401 }));
    await step(10);
    expect(client.getQueryData<ListData>(queryKeys.list('list-1'))?.items[0].note).toBe(
      'new session'
    );
    expect(putJournal()).toHaveLength(1);
  });
});

describe('purchase intent exhausted remount', () => {
  it('F1: stale reads, remounts and failed reads do not remove exhausted intent', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    let release!: (response: Response) => void;
    const stale = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const first = await renderList();
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: stale }, putRespond(500, 'error')]);
    void queryClient.refetchQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    void startToggle(first.result);
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    expect(currentItem().isPurchased).toBe(true);
    expect(putJournal()).toHaveLength(4);
    release(Response.json(makeListData()));
    await step(0);
    expect(currentItem().isPurchased).toBe(true);
    first.unmount();
    const second = await renderList();
    expect(currentItem().isPurchased).toBe(true);
    second.unmount();
    const third = await renderList();
    await step(10_000);
    expect(currentItem().isPurchased).toBe(true);
    expect(putJournal()).toHaveLength(4);
    third.unmount();
  });
});

describe('purchase intent owner isolation controls', () => {
  it('F6: identical list and item ids in two QueryClients have independent optimistic state', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response }]);
    const other = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 300_000 } },
    });
    other.setQueryData(queryKeys.list('list-1'), makeListData());
    const first = await renderList();
    const second = renderHook(() => useShoppingListItems('list-1'), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
          <QueryClientProvider client={other}>{children}</QueryClientProvider>
        </NextIntlClientProvider>
      ),
    });
    void startToggle(first.result);
    await step(10);
    expect(currentItem().isPurchased).toBe(true);
    expect(other.getQueryData<ListData>(queryKeys.list('list-1'))?.items[0].isPurchased).toBe(
      false
    );
    release(new Response('{}', { status: 200 }));
    await step(0);
    second.unmount();
    other.clear();
  });

  it('F6: switching lists and back keeps the original in-flight item', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response }]);
    queryClient.setQueryData(queryKeys.list('list-1'), makeListData());
    queryClient.setQueryData(queryKeys.list('list-2'), { ...makeListData(), id: 'list-2' });
    const rendered = renderHook(({ id }) => useShoppingListItems(id), {
      wrapper,
      initialProps: { id: 'list-1' },
    });
    void startToggle(rendered.result);
    await step(10);
    rendered.rerender({ id: 'list-2' });
    await step(0);
    expect(rendered.result.current.list?.id).toBe('list-2');
    expect(rendered.result.current.items[0].isPurchased).toBe(false);
    rendered.rerender({ id: 'list-1' });
    await step(0);
    expect(rendered.result.current.items[0].isPurchased).toBe(true);
    release(new Response('{}', { status: 200 }));
    await step(0);
    expect(putJournal()).toHaveLength(1);
  });
});

describe('purchase intent already-started ACK', () => {
  it.each([2, 3, 4])(
    'F8: old attempt #%i ACK updates baseline but cannot overlap the new first PUT',
    async (attempt) => {
      let release!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        release = resolve;
      });
      enqueue('PUT', PUT_URL, [
        ...Array.from({ length: attempt - 1 }, () => putRespond(500, '{}')),
        { kind: 'deferred', response },
        putRespond(401, 'denied'),
      ]);
      const rendered = await renderList();
      const { result } = rendered;
      void startToggle(result);
      await step(0);
      for (const delay of [1000, 2000, 4000].slice(0, attempt - 1)) await step(delay);
      expect(putJournal()).toHaveLength(attempt);
      void startToggle(result);
      await step(0);
      expect(currentItem().isPurchased).toBe(false);
      expect(putJournal()).toHaveLength(attempt);
      expect(maxActive.get(PUT_URL)).toBe(1);
      const heldRead = new Promise<Response>(() => {});
      enqueue('GET', LIST_URL, [
        { kind: 'deferred', response: heldRead },
        { kind: 'deferred', response: heldRead },
      ]);
      release(new Response('{}', { status: 200 }));
      await step(10);
      expect(putJournal().map((entry) => entry.body)).toEqual([
        ...Array.from({ length: attempt }, () => ({ isPurchased: true })),
        { isPurchased: false },
      ]);
      expect(currentItem().isPurchased).toBe(true);
      await step(10_000);
      expect(putJournal()).toHaveLength(attempt + 1);
    }
  );
});

describe('purchase intent per-item read generations', () => {
  it('F2: a GET between item ACKs can hand off A but cannot release B', async () => {
    let releaseRead!: (response: Response) => void;
    const read = new Promise<Response>((resolve) => {
      releaseRead = resolve;
    });
    let releaseLater!: (response: Response) => void;
    const later = new Promise<Response>((resolve) => {
      releaseLater = resolve;
    });
    enqueue('PUT', PUT_URL, [putRespond(200, '{}')]);
    let releaseB!: (response: Response) => void;
    const pendingB = new Promise<Response>((resolve) => {
      releaseB = resolve;
    });
    enqueue('PUT', '/api/lists/list-1/items/item-2', [{ kind: 'deferred', response: pendingB }]);
    const { result } = await renderList();
    enqueue('GET', LIST_URL, [
      { kind: 'deferred', response: read },
      { kind: 'deferred', response: later },
    ]);
    void startToggle(result);
    await step(10);
    expect(putJournal()).toHaveLength(1);
    void result.current.togglePurchased('item-2').catch(() => {});
    await step(10);
    expect(putJournal()).toHaveLength(2);
    const staleB = makeListData();
    staleB.items[0].note = 'A handoff';
    releaseRead(Response.json(staleB));
    await step(10);
    expect(currentItem('item-1').note).toBe('A handoff');
    expect(currentItem('item-1').isPurchased).toBe(false);
    expect(currentItem('item-2').isPurchased).toBe(false);
    expect(putJournal()).toHaveLength(2);
    releaseB(Response.json({}));
    releaseLater(Response.json(serverState));
  });
});

describe('neighbor mutation rollback ownership', () => {
  it('the next tap uses the live overlay even if cache purchase data is stale', async () => {
    enqueue('PUT', PUT_URL, [
      putReject(),
      putReject(),
      putReject(),
      putReject(),
      putRespond(200, '{}'),
    ]);
    const { result } = await renderList();
    void startToggle(result);
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    queryClient.setQueryData<ListData>(
      queryKeys.list('list-1'),
      (old) =>
        old && {
          ...old,
          items: old.items.map((item) =>
            item.id === 'item-1' ? { ...item, isPurchased: false } : item
          ),
        }
    );
    void startToggle(result);
    await step(10);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      ...Array.from({ length: 4 }, () => ({ isPurchased: true })),
      { isPurchased: false },
    ]);
  });

  it('an older failed note cannot overwrite a newer note', async () => {
    let releaseOld!: (response: Response) => void;
    let releaseNew!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => {
      releaseOld = resolve;
    });
    const newer = new Promise<Response>((resolve) => {
      releaseNew = resolve;
    });
    const url = '/api/lists/list-1/items/item-2';
    enqueue('PUT', url, [
      { kind: 'deferred', response: old },
      { kind: 'deferred', response: newer },
    ]);
    const { result } = await renderList();
    void result.current.updateNote('item-2', 'old').catch(() => {});
    await step(0);
    void result.current.updateNote('item-2', 'new').catch(() => {});
    await step(0);
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: new Promise<Response>(() => {}) }]);
    releaseOld(new Response('denied', { status: 500 }));
    await step(10);
    expect(currentItem('item-2').note).toBe('new');
    releaseNew(Response.json({}));
  });

  it('a failed delete restores its row with the current purchase overlay', async () => {
    let releaseDelete!: (response: Response) => void;
    const deletion = new Promise<Response>((resolve) => {
      releaseDelete = resolve;
    });
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    enqueue('DELETE', PUT_URL, [{ kind: 'deferred', response: deletion }]);
    const { result } = await renderList();
    void startToggle(result);
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    void result.current.removeItem('item-1').catch(() => {});
    await step(0);
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: new Promise<Response>(() => {}) }]);
    releaseDelete(new Response('denied', { status: 500 }));
    await step(10);
    expect(currentItem().isPurchased).toBe(true);
  });

  it.each(['note', 'delete'] as const)(
    'failed %s preserves newer purchase and its next absolute body',
    async (kind) => {
      let releaseNeighbor!: (response: Response) => void;
      let releasePurchase!: (response: Response) => void;
      const neighbor = new Promise<Response>((resolve) => {
        releaseNeighbor = resolve;
      });
      const purchase = new Promise<Response>((resolve) => {
        releasePurchase = resolve;
      });
      const otherUrl = '/api/lists/list-1/items/item-2';
      enqueue('PUT', PUT_URL, [
        putReject(),
        putReject(),
        putReject(),
        putReject(),
        { kind: 'deferred', response: purchase },
        putRespond(200, '{}'),
      ]);
      enqueue(kind === 'note' ? 'PUT' : 'DELETE', otherUrl, [
        { kind: 'deferred', response: neighbor },
      ]);
      const { result } = await renderList();
      void startToggle(result);
      await step(0);
      for (const delay of [1000, 2000, 4000]) await step(delay);
      const pending =
        kind === 'note'
          ? result.current.updateNote('item-2', 'edit')
          : result.current.removeItem('item-2');
      void pending.catch(() => {});
      await step(0);
      void startToggle(result);
      await step(0);
      const held = new Promise<Response>(() => {});
      enqueue('GET', LIST_URL, [
        { kind: 'deferred', response: held },
        { kind: 'deferred', response: held },
      ]);
      releaseNeighbor(new Response('denied', { status: 500 }));
      await step(10);
      expect(currentItem().isPurchased).toBe(false);
      expect(currentItem('item-2').note).toBe(null);
      void startToggle(result);
      await step(0);
      releasePurchase(new Response('{}', { status: 200 }));
      await step(10);
      expect(
        putJournal()
          .filter((entry) => entry.url === PUT_URL)
          .map((entry) => entry.body)
      ).toEqual([
        ...Array.from({ length: 4 }, () => ({ isPurchased: true })),
        { isPurchased: false },
        { isPurchased: true },
      ]);
    }
  );
});

describe('purchase intent re-arm ownership', () => {
  it('unsent re-arm loses ownership before the actual fetch', async () => {
    enqueue('PUT', PUT_URL, [
      putReject(),
      putReject(),
      putReject(),
      putReject(),
      putRespond(200, '{}'),
    ]);
    const { result } = await renderProviderList();
    void startToggle(result);
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      void startToggle(result);
    });
    await step(10);
    await step(10_000);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      ...Array.from({ length: 4 }, () => ({ isPurchased: true })),
      { isPurchased: false },
    ]);
  });

  it('F8: an in-flight re-arm ACK settles before the new revision and updates its rollback baseline', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    enqueue('PUT', PUT_URL, [
      putReject(),
      putReject(),
      putReject(),
      putReject(),
      { kind: 'deferred', response },
      putRespond(401, 'denied'),
    ]);
    const rendered = await renderProviderList();
    const { result } = rendered;
    void startToggle(result);
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(0);
    expect(putJournal()).toHaveLength(5);
    void startToggle(result);
    await step(0);
    expect(currentItem().isPurchased).toBe(false);
    expect(putJournal()).toHaveLength(5);
    const heldRead = new Promise<Response>(() => {});
    enqueue('GET', LIST_URL, [
      { kind: 'deferred', response: heldRead },
      { kind: 'deferred', response: heldRead },
    ]);
    release(new Response('{}', { status: 200 }));
    await step(10);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      ...Array.from({ length: 5 }, () => ({ isPurchased: true })),
      { isPurchased: false },
    ]);
    expect(currentItem().isPurchased).toBe(true);
    await step(10_000);
    expect(putJournal()).toHaveLength(6);
  });

  it('F3: an edge cannot re-arm a superseded exhausted revision', async () => {
    enqueue('PUT', PUT_URL, [
      putReject(),
      putReject(),
      putReject(),
      putReject(),
      putRespond(200, '{}'),
    ]);
    const { result } = await renderProviderList();
    void startToggle(result);
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    expect(currentItem().isPurchased).toBe(true);
    void startToggle(result);
    await step(10);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      ...Array.from({ length: 4 }, () => ({ isPurchased: true })),
      { isPurchased: false },
    ]);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal()).toHaveLength(5);
  });
});

describe('purchase intent superseded paused retry', () => {
  it('F4: an old paused retry cannot run after a new first attempt', async () => {
    enqueue('PUT', PUT_URL, [putRespond(500, '{}'), putRespond(200, '{}'), putRespond(200, '{}')]);
    const { result } = await renderList();
    void startToggle(result);
    await step(0);
    act(() => onlineManager.setOnline(false));
    await step(1000);
    expect(putJournal()).toHaveLength(1);
    void startToggle(result);
    await step(0);
    expect(putJournal()).toHaveLength(1);
    act(() => onlineManager.setOnline(true));
    await step(10);
    await step(10_000);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      { isPurchased: true },
      { isPurchased: false },
    ]);
  });

  it('F3 control: active and confirmed revisions do not create extra cycles on online edges', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response }]);
    const { result } = await renderList();
    void startToggle(result);
    await step(0);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(0);
    expect(putJournal()).toHaveLength(1);
    release(new Response('{}', { status: 200 }));
    await step(10);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal()).toHaveLength(1);
  });
});

describe('purchase intent per-revision read generations', () => {
  it('F2: a read started before the latest ACK cannot clear the latest overlay', async () => {
    let releaseRead!: (response: Response) => void;
    const read = new Promise<Response>((resolve) => {
      releaseRead = resolve;
    });
    let releaseLater!: (response: Response) => void;
    const later = new Promise<Response>((resolve) => {
      releaseLater = resolve;
    });
    enqueue('PUT', PUT_URL, [putRespond(200, '{}'), putRespond(200, '{}')]);
    const { result } = await renderList();
    enqueue('GET', LIST_URL, [
      { kind: 'deferred', response: read },
      { kind: 'deferred', response: later },
    ]);
    void startToggle(result);
    await step(10);
    void startToggle(result);
    await step(10);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      { isPurchased: true },
      { isPurchased: false },
    ]);
    const old = makeListData();
    old.items[0].isPurchased = true;
    old.items[0].note = 'older read';
    releaseRead(Response.json(old));
    await step(10);
    expect(currentItem().isPurchased).toBe(false);
    expect(putJournal()).toHaveLength(2);
    releaseLater(Response.json(serverState));
  });
});

describe('purchase intent same-user refresh', () => {
  it('F6 control: a same-user session refresh retains a paused intent and resumes its budget', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putRespond(200, '{}')]);
    function Witness() {
      const { status } = useSession();
      return <span data-testid="same-user-status">{status}</span>;
    }
    function Consumer() {
      const { items, togglePurchased } = useShoppingListItems('list-1');
      return (
        <button
          onClick={() => {
            void togglePurchased('item-1').catch(() => {});
          }}
        >
          {items.length ? 'ready' : 'loading'}
        </button>
      );
    }
    render(
      <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
        <Providers>
          <Witness />
          <Consumer />
        </Providers>
      </NextIntlClientProvider>
    );
    await step(10);
    expect(screen.getByTestId('same-user-status').textContent).toBe('authenticated');
    expect(screen.getByRole('button').textContent).toBe('ready');
    fireEvent.click(screen.getByRole('button'));
    await step(0);
    act(() => onlineManager.setOnline(false));
    await step(1000);
    expect(putJournal()).toHaveLength(1);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await step(10);
    expect(screen.getByTestId('same-user-status').textContent).toBe('authenticated');
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal()).toHaveLength(2);
  });
});

describe('purchase intent page observability', () => {
  it('F1: the shipped page logs once per exhausted cycle and retains its pressed toggle', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    const params = Object.assign(Promise.resolve({ listId: 'list-1' }), {
      status: 'fulfilled' as const,
      value: { listId: 'list-1' },
    });
    render(
      <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
        <Providers>
          <ShoppingListPage params={params} />
        </Providers>
      </NextIntlClientProvider>
    );
    await step(10);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const button = screen.getByRole('button', { pressed: false, name: /Молоко/ });
    button.focus();
    fireEvent.click(button);
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    await step(10);
    expect(error).toHaveBeenCalledTimes(1);
    expect(putJournal()).toHaveLength(4);
    expect(
      screen.getByRole('button', { name: 'Куплено: Молоко' }).getAttribute('aria-pressed')
    ).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Куплено: Молоко' }));
    await step(10_000);
    expect(error).toHaveBeenCalledTimes(1);
    expect(putJournal()).toHaveLength(4);
  });
});

describe('purchase intent session ABA', () => {
  it('F6: A to B to A with zero consumers cannot revive the original owner', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response }]);
    let client!: QueryClient;
    function Witness() {
      client = useQueryClient();
      const { data } = useSession();
      return <span data-testid="user">{data?.user?.id ?? 'none'}</span>;
    }
    function Consumer() {
      const { items, togglePurchased } = useShoppingListItems('list-1');
      return (
        <button
          onClick={() => {
            void togglePurchased('item-1').catch(() => {});
          }}
        >
          {items.length ? 'ready' : 'loading'}
        </button>
      );
    }
    function Tree({ visible }: { visible: boolean }) {
      return (
        <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
          <Providers>
            <Witness />
            {visible && <Consumer />}
          </Providers>
        </NextIntlClientProvider>
      );
    }
    const view = render(<Tree visible />);
    await step(10);
    expect(screen.getByTestId('user').textContent).toBe('user-a');
    expect(screen.getByRole('button').textContent).toBe('ready');
    fireEvent.click(screen.getByRole('button'));
    await step(0);
    expect(putJournal()).toHaveLength(1);
    view.rerender(<Tree visible={false} />);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    sessionResponse = { user: { id: 'user-b', name: 'B' }, expires: '2099-01-01T00:00:00.000Z' };
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await step(10);
    expect(screen.getByTestId('user').textContent).toBe('user-b');
    sessionResponse = { user: { id: 'user-a', name: 'A' }, expires: '2099-01-01T00:00:00.000Z' };
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await step(10);
    expect(screen.getByTestId('user').textContent).toBe('user-a');
    const replacement = makeListData();
    replacement.items[0].note = 'new A epoch';
    client.setQueryData(queryKeys.list('list-1'), replacement);
    release(new Response('denied', { status: 401 }));
    await step(10);
    expect(client.getQueryData<ListData>(queryKeys.list('list-1'))?.items[0].note).toBe(
      'new A epoch'
    );
    expect(putJournal()).toHaveLength(1);
  });
});

describe('purchase intent applied overlapping read', () => {
  it('F2: an applied GET between A and B ACK hands off A while B remains protected', async () => {
    let releasePut!: (response: Response) => void;
    let releaseGet!: (response: Response) => void;
    const put = new Promise<Response>((resolve) => {
      releasePut = resolve;
    });
    const get = new Promise<Response>((resolve) => {
      releaseGet = resolve;
    });
    enqueue('PUT', PUT_URL, [putRespond(200, '{}')]);
    enqueue('PUT', '/api/lists/list-1/items/item-2', [{ kind: 'deferred', response: put }]);
    const rendered = await renderList();
    const done = startToggle(rendered.result);
    await step(10);
    await done;
    void rendered.result.current.togglePurchased('item-2').catch(() => {});
    await step(10);
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: get }]);
    void queryClient.refetchQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    rendered.unmount();
    releasePut(new Response('{}', { status: 200 }));
    await step(10);
    const staleB = makeListData();
    staleB.items[0].note = 'applied A read';
    releaseGet(Response.json(staleB));
    await step(10);
    expect(currentItem('item-1').note).toBe('applied A read');
    expect(currentItem('item-1').isPurchased).toBe(false);
    expect(currentItem('item-2').isPurchased).toBe(false);
    expect(putJournal()).toHaveLength(2);
  });

  it('F2: an applied GET between two ACKs cannot clear the later revision', async () => {
    let releasePut!: (response: Response) => void;
    let releaseGet!: (response: Response) => void;
    const put = new Promise<Response>((resolve) => {
      releasePut = resolve;
    });
    const get = new Promise<Response>((resolve) => {
      releaseGet = resolve;
    });
    enqueue('PUT', PUT_URL, [putRespond(200, '{}'), { kind: 'deferred', response: put }]);
    const rendered = await renderList();
    const done = startToggle(rendered.result);
    await step(10);
    await done;
    void startToggle(rendered.result);
    await step(10);
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: get }]);
    void queryClient.refetchQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    rendered.unmount();
    releasePut(new Response('{}', { status: 200 }));
    await step(10);
    const old = makeListData();
    old.items[0].isPurchased = true;
    old.items[0].note = 'applied old read';
    releaseGet(Response.json(old));
    await step(10);
    expect(currentItem().note).toBe('applied old read');
    expect(currentItem().isPurchased).toBe(false);
    expect(putJournal()).toHaveLength(2);
  });
});

describe('purchase intent ABA old settlement', () => {
  it.each([401, 500])(
    'F4: old %i settle cannot overwrite the latest desired value',
    async (status) => {
      let releaseFirst!: (response: Response) => void;
      let releaseSecond!: (response: Response) => void;
      let releaseThird!: (response: Response) => void;
      const first = new Promise<Response>((resolve) => {
        releaseFirst = resolve;
      });
      const second = new Promise<Response>((resolve) => {
        releaseSecond = resolve;
      });
      const third = new Promise<Response>((resolve) => {
        releaseThird = resolve;
      });
      enqueue('PUT', PUT_URL, [
        { kind: 'deferred', response: first },
        { kind: 'deferred', response: second },
        { kind: 'deferred', response: third },
      ]);
      const { result } = await renderList();
      void startToggle(result);
      await step(10);
      void startToggle(result);
      await step(10);
      void startToggle(result);
      await step(10);
      releaseFirst(new Response('failed', { status }));
      await step(10);
      expect(currentItem().isPurchased).toBe(true);
      expect(putJournal().map((entry) => entry.body)).toEqual([
        { isPurchased: true },
        { isPurchased: false },
      ]);
      releaseSecond(new Response('{}', { status: 200 }));
      await step(10);
      expect(currentItem().isPurchased).toBe(true);
      releaseThird(new Response('{}', { status: 200 }));
      await step(10_000);
      expect(putJournal().map((entry) => entry.body)).toEqual([
        { isPurchased: true },
        { isPurchased: false },
        { isPurchased: true },
      ]);
    }
  );

  it('F4 control: one offline-before-first tap sends exactly once when online', async () => {
    enqueue('PUT', PUT_URL, [putRespond(200, '{}')]);
    const { result } = await renderList();
    act(() => onlineManager.setOnline(false));
    void startToggle(result);
    await step(10);
    expect(putJournal()).toHaveLength(0);
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal().map((entry) => entry.body)).toEqual([{ isPurchased: true }]);
  });
});

describe('purchase intent ABA stale read', () => {
  it('F4: an applied pre-settlement GET cannot remove the newest ABA overlay', async () => {
    let releaseFirst!: (response: Response) => void;
    let releaseSecond!: (response: Response) => void;
    let releaseThird!: (response: Response) => void;
    let releaseGet!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<Response>((resolve) => {
      releaseSecond = resolve;
    });
    const third = new Promise<Response>((resolve) => {
      releaseThird = resolve;
    });
    const get = new Promise<Response>((resolve) => {
      releaseGet = resolve;
    });
    enqueue('PUT', PUT_URL, [
      { kind: 'deferred', response: first },
      { kind: 'deferred', response: second },
      { kind: 'deferred', response: third },
    ]);
    const rendered = await renderList();
    void startToggle(rendered.result);
    await step(10);
    void startToggle(rendered.result);
    await step(10);
    void startToggle(rendered.result);
    await step(10);
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: get }]);
    void queryClient.refetchQueries({ queryKey: queryKeys.list('list-1') });
    await step(0);
    rendered.unmount();
    releaseFirst(new Response('{}', { status: 200 }));
    await step(10);
    const stale = makeListData();
    stale.items[0].note = 'stale read applied';
    releaseGet(Response.json(stale));
    await step(10);
    expect(currentItem().note).toBe('stale read applied');
    expect(currentItem().isPurchased).toBe(true);
    releaseSecond(new Response('{}', { status: 200 }));
    await step(10);
    releaseThird(new Response('{}', { status: 200 }));
    await step(10_000);
    expect(putJournal()).toHaveLength(3);
  });
});

describe('purchase intent failed read controls', () => {
  it.each([
    { label: 'transport rejection', queued: () => putReject() },
    { label: 'HTTP 500', queued: () => putRespond(500, 'error') },
    { label: 'invalid JSON', queued: () => putRespond(200, '{') },
  ])('F2: $label after ACK cannot erase the confirmed overlay', async ({ queued }) => {
    enqueue('PUT', PUT_URL, [putRespond(200, '{}')]);
    const { result } = await renderList();
    enqueue('GET', LIST_URL, [queued()]);
    const done = startToggle(result);
    await step(10);
    await done;
    expect(currentItem().isPurchased).toBe(true);
    expect(putJournal()).toHaveLength(1);
    await step(10_000);
    expect(putJournal()).toHaveLength(1);
  });
});

describe('purchase intent provider re-arm', () => {
  it('F3: the real provider re-arms once for two consumers on one online edge', async () => {
    enqueue('PUT', PUT_URL, [
      putReject(),
      putReject(),
      putReject(),
      putReject(),
      putRespond(200, '{}'),
    ]);
    function Consumer({ label }: { label: string }) {
      const { items, togglePurchased } = useShoppingListItems('list-1');
      return (
        <button
          onClick={() => {
            void togglePurchased('item-1').catch(() => {});
          }}
        >
          {items.length ? label : 'loading'}
        </button>
      );
    }
    render(
      <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
        <Providers>
          <Consumer label="first" />
          <Consumer label="second" />
        </Providers>
      </NextIntlClientProvider>
    );
    await step(10);
    fireEvent.click(screen.getByRole('button', { name: 'first' }));
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    expect(putJournal()).toHaveLength(4);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(10);
    expect(putJournal()).toHaveLength(5);
    expect(putJournal()[4].body).toEqual({ isPurchased: true });
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal()).toHaveLength(5);
  });
});

describe('purchase intent session loading', () => {
  it('F6: transient loading and update to the same user retain a paused delivery', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putRespond(200, '{}')]);
    let release!: (response: Response) => void;
    sessionUpdate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    function Consumer() {
      const { status, update } = useSession();
      const { items, togglePurchased } = useShoppingListItems('list-1');
      return (
        <>
          <span data-testid="loading-status">{status}</span>
          <button
            onClick={() => {
              void update({});
            }}
          >
            refresh
          </button>
          <button
            onClick={() => {
              void togglePurchased('item-1').catch(() => {});
            }}
          >
            {items.length ? 'ready' : 'loading list'}
          </button>
        </>
      );
    }
    render(
      <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
        <Providers>
          <Consumer />
        </Providers>
      </NextIntlClientProvider>
    );
    await step(10);
    expect(screen.getByTestId('loading-status').textContent).toBe('authenticated');
    fireEvent.click(screen.getByRole('button', { name: 'ready' }));
    await step(0);
    act(() => onlineManager.setOnline(false));
    await step(1000);
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await step(10);
    expect(screen.getByTestId('loading-status').textContent).toBe('loading');
    expect(putJournal()).toHaveLength(1);
    release(Response.json(sessionResponse));
    await step(10);
    expect(screen.getByTestId('loading-status').textContent).toBe('authenticated');
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal()).toHaveLength(2);
  });
});

describe('purchase intent re-arm observability', () => {
  it('F3: the page emits one error per exhausted cycle and none for individual retries', async () => {
    enqueue(
      'PUT',
      PUT_URL,
      Array.from({ length: 8 }, () => putRespond(500, '{}'))
    );
    const params = Object.assign(Promise.resolve({ listId: 'list-1' }), {
      status: 'fulfilled' as const,
      value: { listId: 'list-1' },
    });
    render(
      <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
        <Providers>
          <ShoppingListPage params={params} />
        </Providers>
      </NextIntlClientProvider>
    );
    await step(10);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Куплено: Молоко' }));
    await step(0);
    for (const delay of [1000, 2000]) {
      await step(delay);
      expect(error).toHaveBeenCalledTimes(0);
    }
    await step(4000);
    expect(error).toHaveBeenCalledTimes(1);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await step(10);
    expect(putJournal()).toHaveLength(5);
    for (const delay of [1000, 2000]) {
      await step(delay);
      expect(error).toHaveBeenCalledTimes(1);
    }
    await step(4000);
    expect(putJournal()).toHaveLength(8);
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('purchase intent provider offline firsts', () => {
  it('F4: the real provider sends every offline queued first attempt in FIFO order', async () => {
    enqueue('PUT', PUT_URL, [putRespond(200, '{}'), putRespond(200, '{}')]);
    const { result } = await renderProviderList();
    act(() => onlineManager.setOnline(false));
    void startToggle(result);
    await step(10);
    void startToggle(result);
    await step(10);
    expect(putJournal()).toHaveLength(0);
    act(() => onlineManager.setOnline(true));
    await step(10_000);
    expect(putJournal().map((entry) => entry.body)).toEqual([
      { isPurchased: true },
      { isPurchased: false },
    ]);
  });
});

describe('purchase intent QueryClient baseline isolation', () => {
  it('F6: an ACK in one QueryClient cannot change the other client rollback baseline', async () => {
    let releaseRead!: (response: Response) => void;
    const read = new Promise<Response>((resolve) => {
      releaseRead = resolve;
    });
    enqueue('PUT', PUT_URL, [putRespond(200, '{}'), putRespond(401, 'denied')]);
    const first = await renderList();
    const other = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 300_000 } },
    });
    other.setQueryData(queryKeys.list('list-1'), makeListData());
    const second = renderHook(() => useShoppingListItems('list-1'), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
          <QueryClientProvider client={other}>{children}</QueryClientProvider>
        </NextIntlClientProvider>
      ),
    });
    const firstDone = startToggle(first.result);
    await step(10);
    await firstDone;
    first.unmount();
    enqueue('GET', LIST_URL, [{ kind: 'deferred', response: read }]);
    void startToggle(second.result);
    await step(10);
    expect(other.getQueryData<ListData>(queryKeys.list('list-1'))?.items[0].isPurchased).toBe(
      false
    );
    expect(putJournal()).toHaveLength(2);
    releaseRead(Response.json(serverState));
    second.unmount();
    other.clear();
  });
});

describe('purchase intent session cache fence', () => {
  it('F6: a new epoch does not reuse an abandoned optimistic value', async () => {
    let client!: QueryClient;
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    enqueue('PUT', PUT_URL, [{ kind: 'deferred', response }]);
    function Witness() {
      client = useQueryClient();
      const { data } = useSession();
      return <span data-testid="epoch-user">{data?.user?.id ?? 'none'}</span>;
    }
    function Consumer() {
      const { items, togglePurchased } = useShoppingListItems('list-1');
      return (
        <button
          onClick={() => {
            void togglePurchased('item-1').catch(() => {});
          }}
        >
          {String(items[0]?.isPurchased)}
        </button>
      );
    }
    function Tree({ visible }: { visible: boolean }) {
      return (
        <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
          <Providers>
            <Witness />
            {visible && <Consumer />}
          </Providers>
        </NextIntlClientProvider>
      );
    }
    const view = render(<Tree visible />);
    await step(10);
    fireEvent.click(screen.getByRole('button', { name: 'false' }));
    await step(0);
    expect(client.getQueryData<ListData>(queryKeys.list('list-1'))?.items[0].isPurchased).toBe(
      true
    );
    view.rerender(<Tree visible={false} />);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    sessionResponse = { user: { id: 'user-b' }, expires: '2099-01-01T00:00:00.000Z' };
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await step(10);
    expect(screen.getByTestId('epoch-user').textContent).toBe('user-b');
    view.rerender(<Tree visible />);
    await step(10);
    expect(screen.getByRole('button').textContent).toBe('false');
    release(new Response('{}', { status: 200 }));
    await step(10);
    expect(screen.getByRole('button').textContent).toBe('false');
    expect(putJournal()).toHaveLength(1);
  });
});

describe('purchase intent cache eviction', () => {
  it('F1: an exhausted intent survives query eviction while the provider stays mounted', async () => {
    enqueue('PUT', PUT_URL, [putReject(), putReject(), putReject(), putReject()]);
    let client!: QueryClient;
    function Witness() {
      client = useQueryClient();
      return null;
    }
    function Consumer() {
      const { items, togglePurchased } = useShoppingListItems('list-1');
      return (
        <button
          onClick={() => {
            void togglePurchased('item-1').catch(() => {});
          }}
        >
          {String(items[0]?.isPurchased)}
        </button>
      );
    }
    function Tree({ visible }: { visible: boolean }) {
      return (
        <NextIntlClientProvider locale="ru" messages={messages.ru} timeZone="UTC">
          <Providers>
            <Witness />
            {visible && <Consumer />}
          </Providers>
        </NextIntlClientProvider>
      );
    }
    const view = render(<Tree visible />);
    await step(10);
    fireEvent.click(screen.getByRole('button', { name: 'false' }));
    await step(0);
    for (const delay of [1000, 2000, 4000]) await step(delay);
    expect(screen.getByRole('button').textContent).toBe('true');
    view.rerender(<Tree visible={false} />);
    client.removeQueries({ queryKey: queryKeys.list('list-1') });
    view.rerender(<Tree visible />);
    await step(10);
    expect(screen.getByRole('button').textContent).toBe('true');
    expect(putJournal()).toHaveLength(4);
  });
});
