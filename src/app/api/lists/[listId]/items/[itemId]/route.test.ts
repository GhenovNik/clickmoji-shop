// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeListDb, product, type FakeItem } from '@/test/fake-list-db';

// Every change to the items of a list takes the list row lock first (list, then items), the same
// lock POST /api/history holds while it snapshots and removes the items. An item edit therefore
// either commits before the snapshot is read or waits and then finds the item gone.

const holder = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeListDb>,
  requireUser: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({ requireUser: holder.requireUser }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_target, prop) => Reflect.get(holder.db.prisma, prop) }),
}));

const { PUT, DELETE } = await import('./route');

const item = (id: string, listId = 'list-b'): FakeItem => ({
  id,
  listId,
  productId: 'milk',
  variantId: null,
  note: '1 л',
  isPurchased: false,
  createdAt: new Date('2026-10-01T10:00:00Z'),
});

const params = (itemId: string, listId = 'list-b') => ({
  params: Promise.resolve({ listId, itemId }),
});

const put = (body: unknown, itemId = 'item-1', listId = 'list-b') =>
  PUT(
    new Request('http://localhost/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(itemId, listId)
  );

const remove = (itemId = 'item-1', listId = 'list-b') =>
  DELETE(new Request('http://localhost/', { method: 'DELETE' }), params(itemId, listId));

const ordered = (names: string[]) => holder.db.calls.filter((call) => names.includes(call));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  holder.requireUser.mockResolvedValue({ session: { user: { id: 'user-b', role: 'USER' } } });
  holder.db = createFakeListDb({
    products: [product({ id: 'milk' })],
    lists: [
      { id: 'list-b', userId: 'user-b', name: 'Покупки', isActive: true },
      { id: 'list-a', userId: 'user-a', name: 'Чужой', isActive: true },
    ],
    items: [item('item-1'), item('item-a', 'list-a')],
  });
});

describe('PUT /api/lists/[listId]/items/[itemId]', () => {
  it('locks the list row before it reads or updates the item', async () => {
    const response = await put({ note: '3 л', isPurchased: true });

    expect(response.status).toBe(200);
    expect(ordered(['$queryRaw:lists', 'item.findFirst', 'item.update'])).toEqual([
      '$queryRaw:lists',
      'item.findFirst',
      'item.update',
    ]);
    expect(holder.db.state.items[0]).toMatchObject({ note: '3 л', isPurchased: true });
  });

  it('answers 404 for an item that is gone once the lock is held', async () => {
    holder.db.state.items = holder.db.state.items.filter((row) => row.id !== 'item-1');

    const response = await put({ note: '3 л' });

    expect(response.status).toBe(404);
  });

  it("answers 404 for another user's list without touching its items", async () => {
    const response = await put({ note: 'x' }, 'item-a', 'list-a');

    expect(response.status).toBe(404);
    expect(holder.db.state.items.find((row) => row.id === 'item-a')?.note).toBe('1 л');
  });
});

describe('DELETE /api/lists/[listId]/items/[itemId]', () => {
  it('locks the list row before it deletes the item', async () => {
    const response = await remove();

    expect(response.status).toBe(200);
    expect(ordered(['$queryRaw:lists', 'item.deleteMany'])).toEqual([
      '$queryRaw:lists',
      'item.deleteMany',
    ]);
    expect(holder.db.state.items.map((row) => row.id)).toEqual(['item-a']);
  });

  it("answers 404 for another user's list without deleting", async () => {
    const response = await remove('item-a', 'list-a');

    expect(response.status).toBe(404);
    expect(holder.db.state.items).toHaveLength(2);
  });
});
