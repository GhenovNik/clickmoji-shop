import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { messages } from '@/i18n/messages';
import { queryKeys } from '@/lib/query-keys';
import { useShoppingListItems, type ListData } from './useShoppingListItems';

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
  { kind: 'reject'; error: unknown } | { kind: 'respond'; status: number; body: string | null };

const LIST_URL = '/api/lists/list-1';
const PUT_URL = '/api/lists/list-1/items/item-1';

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
      journal.push({ method, url, body });

      const next = queues.get(key(method, url))?.shift();
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
  it('AC-1: four transport rejects keep the optimistic value, then exactly one BASE rollback after the 4th attempt', async () => {
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
    expect(currentItem().isPurchased).toBe(false);
    expect(rollbackCount()).toBe(1);

    await done;
    for (const entry of putJournal()) {
      expect(entry.body).toEqual({ isPurchased: true });
    }
    expect(currentItem().isPurchased).toBe(false);
    expect(rollbackCount()).toBe(1);

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
    'AC-4 retryable: $name exhausts the budget of 4 PUTs, then one BASE rollback',
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
      expect(currentItem().isPurchased).toBe(false);
      expect(rollbackCount()).toBe(1);

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
    'AC-4 permanent: $name yields exactly one PUT, no retry, one BASE rollback',
    async ({ status }) => {
      enqueue('PUT', PUT_URL, [putRespond(status, 'error')]);
      const { result } = await renderList();
      const done = startToggle(result);

      await step(0);
      await step(10_000);

      expect(putJournal()).toHaveLength(1);
      expect(currentItem().isPurchased).toBe(false);
      expect(rollbackCount()).toBe(1);

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
    expect(currentItem().isPurchased).toBe(false);
    expect(rollbackCount()).toBe(1);

    await done;
    expect(putJournal()).toHaveLength(4);
    expect(rollbackCount()).toBe(1);
    expect(currentItem().isPurchased).toBe(false);
  });

  it.each([
    { name: 'transport reject then HTTP 401', second: () => putRespond(401, 'unauthorized') },
    { name: 'transport reject then HTTP 302', second: () => putRespond(302, 'redirect') },
  ])(
    'FR-1 neighbor: $name — exactly two PUTs with the same body, one terminal rollback, no extra PUT',
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
      expect(rollbackCount()).toBe(1);

      await done;
      expect(putJournal()).toHaveLength(2);
    }
  );
});
