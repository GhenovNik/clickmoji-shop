// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeListDb, product, type FakeItem } from '@/test/fake-list-db';

// Completing a list moves its items into a history snapshot. Whatever happens concurrently, an
// item must end up in exactly one place: in the snapshot or still in the list.

const holder = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeListDb>,
  requireUser: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({ requireUser: holder.requireUser }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_target, prop) => Reflect.get(holder.db.prisma, prop) }),
}));

const { POST } = await import('./route');

const item = (id: string, productId: string, listId = 'list-b'): FakeItem => ({
  id,
  listId,
  productId,
  variantId: null,
  note: null,
  isPurchased: false,
  createdAt: new Date('2026-10-01T10:00:00Z'),
});

function complete(listId = 'list-b') {
  return POST(
    new Request('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listId }),
    })
  );
}

const snapshotProductIds = () => holder.db.state.historyItems.map((row) => row.productId);
const listItemIds = (listId = 'list-b') =>
  holder.db.state.items.filter((row) => row.listId === listId).map((row) => row.id);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  holder.requireUser.mockResolvedValue({ session: { user: { id: 'user-b', role: 'USER' } } });
  holder.db = createFakeListDb({
    products: [
      product({ id: 'milk' }),
      product({ id: 'bread' }),
      product({ id: 'eggs' }),
      product({ id: 'foreign-private', isGlobal: false, createdById: 'user-a' }),
    ],
    lists: [
      { id: 'list-b', userId: 'user-b', name: 'Покупки', isActive: true },
      { id: 'list-a', userId: 'user-a', name: 'Чужой', isActive: true },
    ],
    items: [
      item('item-milk', 'milk'),
      item('item-bread', 'bread'),
      item('item-a', 'milk', 'list-a'),
    ],
  });
});

describe('POST /api/history (complete a list)', () => {
  it('keeps an item added after the snapshot was read in the list instead of losing it', async () => {
    // A concurrent POST /api/lists/[listId]/items commits right after the snapshot read.
    let interleaved = false;
    holder.db.hooks.afterItemsRead = () => {
      if (interleaved) return;
      interleaved = true;
      holder.db.state.items.push(item('item-late', 'eggs'));
    };

    const response = await complete();

    expect(response.status).toBe(200);
    expect(interleaved).toBe(true);
    const inSnapshot = snapshotProductIds().includes('eggs');
    const inList = listItemIds().includes('item-late');
    expect({ inSnapshot, inList }).toEqual({ inSnapshot: false, inList: true });
    expect(snapshotProductIds()).toEqual(['milk', 'bread']);
  });

  it('moves every item it read into one snapshot and empties the list', async () => {
    const response = await complete();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.listName).toBe('Покупки');
    expect(body.items.map((row: { productId: string }) => row.productId)).toEqual([
      'milk',
      'bread',
    ]);
    expect(holder.db.state.histories).toHaveLength(1);
    expect(listItemIds()).toEqual([]);
    expect(listItemIds('list-a')).toEqual(['item-a']);
  });

  it('removes a legacy item of a product the user cannot see without copying it', async () => {
    holder.db.state.items.push(item('item-legacy', 'foreign-private'));

    const response = await complete();

    expect(response.status).toBe(200);
    expect(snapshotProductIds()).toEqual(['milk', 'bread']);
    expect(listItemIds()).toEqual([]);
  });

  it('returns 400 for an empty list without creating a snapshot', async () => {
    holder.db.state.items = [];

    const response = await complete();

    expect(response.status).toBe(400);
    expect(holder.db.state.histories).toEqual([]);
  });

  it("returns 404 for another user's list without touching it", async () => {
    const response = await complete('list-a');

    expect(response.status).toBe(404);
    expect(holder.db.state.histories).toEqual([]);
    expect(listItemIds('list-a')).toEqual(['item-a']);
  });

  it('rolls the snapshot back when removing the items fails', async () => {
    const deleteMany = holder.db.prisma.item.deleteMany;
    holder.db.prisma.item.deleteMany = async () => {
      throw new Error('connection reset');
    };

    const response = await complete();
    holder.db.prisma.item.deleteMany = deleteMany;

    expect(response.status).toBe(500);
    expect(holder.db.state.histories).toEqual([]);
    expect(holder.db.state.historyItems).toEqual([]);
    expect(listItemIds()).toEqual(['item-milk', 'item-bread']);
  });
});
