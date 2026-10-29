// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeListDb, product } from '@/test/fake-list-db';

// Restoring a snapshot creates a list and its items as one operation: a failure part-way must
// not leave a half-filled (or empty) list behind.

const holder = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeListDb>,
  requireUser: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({ requireUser: holder.requireUser }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_target, prop) => Reflect.get(holder.db.prisma, prop) }),
}));

const { POST } = await import('./route');

const historyItem = (id: string, productId: string | null, variantId: string | null = null) => ({
  id,
  historyId: 'history-b',
  productId,
  variantId,
  productName: productId ?? 'Без ссылки',
  productEmoji: '🛒',
  categoryName: 'Молочное',
  note: null,
  isPurchased: true,
});

function restore(historyId = 'history-b') {
  return POST(
    new Request(`http://localhost/api/history/${historyId}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Список от 1 октября' }),
    }),
    { params: Promise.resolve({ historyId }) }
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  holder.requireUser.mockResolvedValue({ session: { user: { id: 'user-b', role: 'USER' } } });
  holder.db = createFakeListDb({
    products: [
      product({ id: 'milk' }),
      product({ id: 'bread' }),
      product({ id: 'foreign-private', isGlobal: false, createdById: 'user-a' }),
    ],
    variants: [{ id: 'milk-2pct', productId: 'milk', name: '2%', emoji: '🥛' }],
    lists: [{ id: 'list-b', userId: 'user-b', name: 'Покупки', isActive: true }],
    histories: [
      {
        id: 'history-b',
        userId: 'user-b',
        listId: null,
        listName: 'Покупки',
        completedAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        id: 'history-a',
        userId: 'user-a',
        listId: null,
        listName: 'Чужой',
        completedAt: new Date('2026-10-01T10:00:00Z'),
      },
    ],
    historyItems: [
      historyItem('h-milk', 'milk', 'milk-2pct'),
      historyItem('h-bread', 'bread', 'milk-2pct'),
      historyItem('h-foreign', 'foreign-private'),
      historyItem('h-deleted', 'deleted-product'),
      historyItem('h-null', null),
    ],
  });
});

describe('POST /api/history/[historyId]/restore', () => {
  it('leaves no list behind when inserting the items fails', async () => {
    holder.db.hooks.beforeItemInsert = (row) => {
      if (row.productId === 'bread') throw new Error('connection reset');
    };

    const response = await restore();

    expect(response.status).toBe(500);
    expect(holder.db.state.lists.map((list) => list.id)).toEqual(['list-b']);
    expect(holder.db.state.items).toEqual([]);
  });

  it('creates one inactive list with the visible items and drops foreign variants', async () => {
    const response = await restore();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ listId: expect.any(String), createdCount: 2, skippedCount: 3 });
    const restored = holder.db.state.lists.find((list) => list.id === body.listId);
    expect(restored).toMatchObject({ userId: 'user-b', name: 'Список от 1 октября' });
    expect(restored?.isActive).toBe(false);
    expect(
      holder.db.state.items.map((row) => [
        row.listId,
        row.productId,
        row.variantId,
        row.isPurchased,
      ])
    ).toEqual([
      [body.listId, 'milk', 'milk-2pct', false],
      [body.listId, 'bread', null, false],
    ]);
  });

  it('looks products and variants up once for the whole snapshot', async () => {
    await restore();

    const lookups = holder.db.calls.filter(
      (call) => call.startsWith('product.') || call.startsWith('productVariant.')
    );
    expect(lookups.sort()).toEqual(['product.findMany', 'productVariant.findMany']);
  });

  it("returns 404 for another user's snapshot without creating a list", async () => {
    const response = await restore('history-a');

    expect(response.status).toBe(404);
    expect(holder.db.state.lists).toHaveLength(1);
  });
});
