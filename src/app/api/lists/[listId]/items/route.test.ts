// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeListDb, product } from '@/test/fake-list-db';

// A batch add is one operation: either every item of the request lands in the list or none does,
// and the number of lookups does not grow with the size of the batch.

const holder = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeListDb>,
  requireUser: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({ requireUser: holder.requireUser }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_target, prop) => Reflect.get(holder.db.prisma, prop) }),
}));

const { POST } = await import('./route');

const PRODUCTS = [
  product({ id: 'milk' }),
  product({ id: 'bread' }),
  product({ id: 'own-private', isGlobal: false, createdById: 'user-b' }),
  product({ id: 'foreign-private', isGlobal: false, createdById: 'user-a' }),
  ...Array.from({ length: 60 }, (_, index) => product({ id: `bulk-${index}` })),
];
const VARIANTS = [
  { id: 'milk-2pct', productId: 'milk', name: '2%', emoji: '🥛' },
  { id: 'bread-rye', productId: 'bread', name: 'Ржаной', emoji: '🍞' },
  ...Array.from({ length: 60 }, (_, index) => ({
    id: `bulk-${index}-v`,
    productId: `bulk-${index}`,
    name: 'v',
    emoji: '🛒',
  })),
];

function addItems(items: unknown, listId = 'list-b') {
  return POST(
    new Request(`http://localhost/api/lists/${listId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    }),
    { params: Promise.resolve({ listId }) }
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  holder.requireUser.mockResolvedValue({ session: { user: { id: 'user-b', role: 'USER' } } });
  holder.db = createFakeListDb({
    products: PRODUCTS,
    variants: VARIANTS,
    lists: [
      { id: 'list-b', userId: 'user-b', name: 'Покупки', isActive: true },
      { id: 'list-a', userId: 'user-a', name: 'Чужой', isActive: true },
    ],
  });
});

const lookupCalls = () =>
  holder.db.calls.filter(
    (call) => call.startsWith('product.') || call.startsWith('productVariant.')
  );

describe('POST /api/lists/[listId]/items is all-or-nothing', () => {
  it('writes nothing when the last item references a product the user cannot see', async () => {
    const response = await addItems([
      { productId: 'milk' },
      { productId: 'bread', note: '2 шт' },
      { productId: 'foreign-private' },
    ]);

    expect(response.status).toBe(404);
    expect(holder.db.state.items).toEqual([]);
  });

  it('writes nothing when the last item has a variant of another product', async () => {
    const response = await addItems([
      { productId: 'milk', variantId: 'milk-2pct' },
      { productId: 'bread', variantId: 'milk-2pct' },
    ]);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Variant does not belong to product' });
    expect(holder.db.state.items).toEqual([]);
  });

  it('writes nothing when the database rejects a row in the middle of the batch', async () => {
    holder.db.hooks.beforeItemInsert = (row) => {
      if (row.productId === 'bread') throw new Error('connection reset');
    };

    const response = await addItems([
      { productId: 'milk' },
      { productId: 'bread' },
      { productId: 'own-private' },
    ]);

    expect(response.status).toBe(500);
    expect(holder.db.state.items).toEqual([]);
  });

  it('rejects an item without a product id before any write', async () => {
    const response = await addItems([{ productId: 'milk' }, { note: 'без товара' }]);

    expect(response.status).toBe(400);
    expect(holder.db.state.items).toEqual([]);
  });

  it('adds a valid batch in request order with product, category and variant ids', async () => {
    const response = await addItems([
      { productId: 'milk', variantId: 'milk-2pct', note: '2 л' },
      { productId: 'own-private' },
      { productId: 'milk' },
    ]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toBe('Добавлено 3 товаров.');
    expect(
      body.createdItems.map((item: { productId: string; variantId: string | null }) => [
        item.productId,
        item.variantId,
      ])
    ).toEqual([
      ['milk', 'milk-2pct'],
      ['own-private', null],
      ['milk', null],
    ]);
    expect(body.createdItems[0].product.category.name).toBe('Молочное');
    expect(body.createdItems[0].note).toBe('2 л');
    expect(holder.db.state.items).toHaveLength(3);
  });

  it("returns 404 for another user's list without writing", async () => {
    const response = await addItems([{ productId: 'milk' }], 'list-a');

    expect(response.status).toBe(404);
    expect(holder.db.state.items).toEqual([]);
  });
});

describe('POST /api/lists/[listId]/items takes the list lock', () => {
  it('locks the list row before it inserts, like every other change to the items', async () => {
    const response = await addItems([{ productId: 'milk' }]);

    expect(response.status).toBe(200);
    expect(
      holder.db.calls.filter((call) =>
        ['$queryRaw:lists', 'item.createManyAndReturn'].includes(call)
      )
    ).toEqual(['$queryRaw:lists', 'item.createManyAndReturn']);
  });
});

describe('POST /api/lists/[listId]/items is bounded', () => {
  it('rejects a batch above 100 items with 400 and writes nothing', async () => {
    const items = Array.from({ length: 101 }, () => ({ productId: 'milk' }));

    const response = await addItems(items);

    expect(response.status).toBe(400);
    expect(holder.db.state.items).toEqual([]);
    expect(lookupCalls()).toEqual([]);
  });

  it('accepts exactly 100 items', async () => {
    const items = Array.from({ length: 100 }, () => ({ productId: 'milk' }));

    const response = await addItems(items);

    expect(response.status).toBe(200);
    expect(holder.db.state.items).toHaveLength(100);
  });

  it('looks products and variants up once per batch, not once per item', async () => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      productId: `bulk-${index}`,
      variantId: `bulk-${index}-v`,
    }));

    const response = await addItems(items);

    expect(response.status).toBe(200);
    expect(holder.db.state.items).toHaveLength(60);
    expect(lookupCalls()).toEqual(['product.findMany', 'productVariant.findMany']);
  });
});
