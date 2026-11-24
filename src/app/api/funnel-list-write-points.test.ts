// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeInitDb } from '@/test/fake-init-db';
import { createFakeListDb, product, type FakeItem } from '@/test/fake-list-db';
import { FUNNEL_GUEST_COOKIE } from '@/lib/funnel';

const holder = vi.hoisted(() => ({
  db: null as unknown as { prisma: Record<string, unknown> },
  requireUser: vi.fn(),
  funnelCreate: vi.fn(),
  funnelUpdateMany: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({ requireUser: holder.requireUser }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'funnelEvent') {
          return { create: holder.funnelCreate, updateMany: holder.funnelUpdateMany };
        }
        return Reflect.get(holder.db.prisma, prop);
      },
    }
  ),
}));

const { POST: createList } = await import('@/app/api/lists/route');
const { POST: initLists } = await import('@/app/api/lists/init/route');
const { POST: restoreHistory } = await import('@/app/api/history/[historyId]/restore/route');
const { POST: addItems } = await import('@/app/api/lists/[listId]/items/route');
const { PUT: updateItem } = await import('@/app/api/lists/[listId]/items/[itemId]/route');

const GUEST_ID = 'guest_lists_1234567890';
const COOKIE_HEADERS = {
  'content-type': 'application/json',
  cookie: `NEXT_LOCALE=en; ${FUNNEL_GUEST_COOKIE}=${GUEST_ID}`,
};

const makeItem = (id: string, isPurchased = false): FakeItem => ({
  id,
  listId: 'list-1',
  productId: 'milk',
  variantId: null,
  note: null,
  isPurchased,
  createdAt: new Date('2026-10-01T10:00:00Z'),
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  holder.requireUser.mockReset().mockResolvedValue({
    session: { user: { id: 'user-1', role: 'USER' } },
  });
  holder.funnelCreate.mockReset().mockResolvedValue({ id: 'evt-1' });
  holder.funnelUpdateMany.mockReset().mockResolvedValue({ count: 0 });
});

describe('POST /api/lists and POST /api/lists/init funnel recording', () => {
  it('records LIST_CREATE on POST /api/lists and preserves success on funnel failure', async () => {
    const fakeDb = createFakeListDb({ lists: [] });
    holder.db = fakeDb;

    const okRes = await createList(
      new Request('http://localhost/api/lists', {
        method: 'POST',
        headers: COOKIE_HEADERS,
        body: JSON.stringify({ name: 'Groceries', isActive: false }),
      })
    );
    expect(okRes.status).toBe(200);
    expect(holder.funnelCreate).toHaveBeenCalledWith({
      data: { type: 'LIST_CREATE', userId: 'user-1', guestId: GUEST_ID },
    });

    holder.funnelCreate.mockRejectedValueOnce(new Error('db down'));
    const resilientRes = await createList(
      new Request('http://localhost/api/lists', {
        method: 'POST',
        headers: COOKIE_HEADERS,
        body: JSON.stringify({ name: 'Weekend', isActive: false }),
      })
    );
    expect(resilientRes.status).toBe(200);
    expect(fakeDb.state.lists).toHaveLength(2);
  });

  it('records LIST_CREATE on POST /api/lists/init only when lists are actually created', async () => {
    const initDb = createFakeInitDb();
    holder.db = initDb;

    const firstRes = await initLists(
      new Request('http://localhost/api/lists/init', {
        method: 'POST',
        headers: { cookie: `NEXT_LOCALE=en; ${FUNNEL_GUEST_COOKIE}=${GUEST_ID}` },
      })
    );
    expect(firstRes.status).toBe(200);
    expect(holder.funnelCreate).toHaveBeenCalledTimes(1);
    expect(holder.funnelCreate).toHaveBeenCalledWith({
      data: { type: 'LIST_CREATE', userId: 'user-1', guestId: GUEST_ID },
    });

    holder.funnelCreate.mockClear();
    const secondRes = await initLists(
      new Request('http://localhost/api/lists/init', {
        method: 'POST',
        headers: { cookie: `NEXT_LOCALE=en; ${FUNNEL_GUEST_COOKIE}=${GUEST_ID}` },
      })
    );
    expect(secondRes.status).toBe(200);
    expect(holder.funnelCreate).not.toHaveBeenCalled();
  });
});

describe('restore, item add, and purchase transition funnel recording', () => {
  it('records LIST_CREATE and ITEM_ADD on restore with visible items, and only LIST_CREATE when none restored', async () => {
    holder.db = createFakeListDb({
      products: [product({ id: 'milk' })],
      histories: [
        {
          id: 'h-with-items',
          userId: 'user-1',
          listId: null,
          listName: 'Weekly',
          completedAt: new Date(),
        },
        {
          id: 'h-empty',
          userId: 'user-1',
          listId: null,
          listName: 'Gone',
          completedAt: new Date(),
        },
      ],
      historyItems: [
        {
          id: 'hi-1',
          historyId: 'h-with-items',
          productId: 'milk',
          variantId: null,
          productName: 'Milk',
          productEmoji: '🥛',
          categoryName: 'Dairy',
          note: null,
          isPurchased: true,
        },
        {
          id: 'hi-2',
          historyId: 'h-empty',
          productId: 'deleted-product',
          variantId: null,
          productName: 'Deleted',
          productEmoji: '📦',
          categoryName: 'Other',
          note: null,
          isPurchased: true,
        },
      ],
    });

    const withItemsRes = await restoreHistory(
      new Request('http://localhost/api/history/h-with-items/restore', {
        method: 'POST',
        headers: COOKIE_HEADERS,
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ historyId: 'h-with-items' }) }
    );
    expect(withItemsRes.status).toBe(200);
    expect(holder.funnelCreate.mock.calls.map(([arg]) => arg.data)).toEqual([
      { type: 'LIST_CREATE', userId: 'user-1', guestId: GUEST_ID },
      { type: 'ITEM_ADD', userId: 'user-1', guestId: GUEST_ID },
    ]);

    holder.funnelCreate.mockClear();
    const emptyRes = await restoreHistory(
      new Request('http://localhost/api/history/h-empty/restore', {
        method: 'POST',
        headers: COOKIE_HEADERS,
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ historyId: 'h-empty' }) }
    );
    expect(emptyRes.status).toBe(200);
    expect(holder.funnelCreate.mock.calls.map(([arg]) => arg.data)).toEqual([
      { type: 'LIST_CREATE', userId: 'user-1', guestId: GUEST_ID },
    ]);
  });

  it('records ITEM_ADD on non-AI POST /api/lists/[listId]/items and preserves success on funnel failure', async () => {
    const fakeDb = createFakeListDb({
      products: [product({ id: 'milk' })],
      lists: [{ id: 'list-1', userId: 'user-1', name: 'Main', isActive: true }],
    });
    holder.db = fakeDb;

    holder.funnelCreate.mockRejectedValueOnce(new Error('funnel unavailable'));

    const response = await addItems(
      new Request('http://localhost/api/lists/list-1/items', {
        method: 'POST',
        headers: COOKIE_HEADERS,
        body: JSON.stringify({ items: [{ productId: 'milk' }] }),
      }),
      { params: Promise.resolve({ listId: 'list-1' }) }
    );

    expect(response.status).toBe(200);
    expect(fakeDb.state.items).toHaveLength(1);
    expect(holder.funnelCreate).toHaveBeenCalledWith({
      data: { type: 'ITEM_ADD', userId: 'user-1', guestId: GUEST_ID },
    });
  });

  it('records ITEM_PURCHASE only on false -> true transition, skipping duplicate/no-op/unpurchase', async () => {
    const fakeDb = createFakeListDb({
      products: [product({ id: 'milk' })],
      lists: [{ id: 'list-1', userId: 'user-1', name: 'Main', isActive: true }],
      items: [makeItem('item-1', false)],
    });
    holder.db = fakeDb;

    const sendPut = (body: unknown) =>
      updateItem(
        new Request('http://localhost/api/lists/list-1/items/item-1', {
          method: 'PUT',
          headers: COOKIE_HEADERS,
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ listId: 'list-1', itemId: 'item-1' }) }
      );

    // Note-only update while unpurchased -> no event.
    expect((await sendPut({ note: '2L' })).status).toBe(200);
    expect(holder.funnelCreate).not.toHaveBeenCalled();

    // Transition false -> true -> records ITEM_PURCHASE.
    expect((await sendPut({ isPurchased: true })).status).toBe(200);
    expect(holder.funnelCreate).toHaveBeenCalledTimes(1);
    expect(holder.funnelCreate).toHaveBeenCalledWith({
      data: { type: 'ITEM_PURCHASE', userId: 'user-1', guestId: GUEST_ID },
    });

    // Duplicate true -> true -> no event.
    holder.funnelCreate.mockClear();
    expect((await sendPut({ isPurchased: true })).status).toBe(200);
    expect(holder.funnelCreate).not.toHaveBeenCalled();

    // Unpurchase true -> false -> no event.
    expect((await sendPut({ isPurchased: false })).status).toBe(200);
    expect(holder.funnelCreate).not.toHaveBeenCalled();

    // Transition false -> true with funnel failure -> core update still returns 200.
    holder.funnelCreate.mockRejectedValueOnce(new Error('funnel write error'));
    const resilientRes = await sendPut({ isPurchased: true });
    expect(resilientRes.status).toBe(200);
    expect((await resilientRes.json()).isPurchased).toBe(true);
  });
});
