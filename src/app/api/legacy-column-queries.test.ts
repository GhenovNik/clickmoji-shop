// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// AGE-1667 Ya3 review: the legacy English picture columns are a write-only rollback mirror. Every
// route that serves product, variant or history rows reads them with `omit`, so the old column
// never reaches a client. The fake database applies `omit` the way Prisma does: a query that
// forgets it returns the column and the response check below fails.

const LEGACY = 'https://utfs.io/f/legacy-only';

const db = vi.hoisted(() => {
  const calls: Array<{ model: string; op: string; args: Record<string, any> }> = [];
  return { calls, sql: [] as unknown[] };
});

vi.mock('@/lib/auth-guards', () => ({
  requireUser: async () => ({ session: { user: { id: 'user-1', role: 'USER' } } }),
}));
vi.mock('@/lib/funnel', () => ({
  getGuestIdFromRequest: () => null,
  recordFunnelEvent: async () => undefined,
}));

type Row = Record<string, unknown>;
const withoutColumns = (row: Row, omit: Record<string, boolean> = {}): Row =>
  Object.fromEntries(Object.entries(row).filter(([column]) => !omit[column]));

const productRow = (): Row => ({
  id: 'p1',
  name: 'Яблоко',
  nameEn: 'Apple',
  emoji: '🍎',
  isCustom: true,
  imageUrl: 'https://utfs.io/f/main',
  imageUrlEn: LEGACY,
  localizedImages: { en: 'https://utfs.io/f/dictionary-en' },
  categoryId: 'c1',
});
const variantRow = (): Row => ({
  id: 'v1',
  productId: 'p1',
  name: 'Красное',
  nameEn: 'Red',
  emoji: '🍎',
  imageUrl: null,
  imageUrlEn: LEGACY,
  localizedImages: null,
});
const historyItemRow = (): Row => ({
  id: 'h1',
  productId: 'p1',
  variantId: null,
  productName: 'Яблоко',
  productImageUrl: 'https://utfs.io/f/main',
  productImageUrlEn: LEGACY,
  localizedImages: { en: 'https://utfs.io/f/dictionary-en' },
});

// A product (or variant) as the database returns it for the given query arguments.
function shapeProduct(args: Record<string, any>): Row {
  const row = withoutColumns(productRow(), args.omit);
  if (args.include?.category) row.category = { id: 'c1', name: 'Фрукты' };
  return row;
}
function shapeItem(args: Record<string, any>, extra: Row = {}): Row {
  const include = args.include ?? {};
  return {
    id: 'i1',
    productId: 'p1',
    variantId: 'v1',
    note: null,
    isPurchased: false,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    ...extra,
    ...(include.product && { product: shapeProduct(include.product) }),
    ...(include.variant &&
      include.variant !== true && { variant: withoutColumns(variantRow(), include.variant.omit) }),
    ...(include.variant === true && { variant: variantRow() }),
  };
}

function record(model: string, op: string, args: Record<string, any>) {
  db.calls.push({ model, op, args });
}

function makeTx() {
  return {
    $queryRaw: async () => [{ id: 'list-1', name: 'Покупки' }],
    item: {
      findFirst: async (args: Row) => (
        record('item', 'findFirst', args),
        { id: 'i1', isPurchased: false }
      ),
      findMany: async (args: Record<string, any>) => (
        record('item', 'findMany', args),
        [shapeItem(args)]
      ),
      update: async (args: Record<string, any>) => (
        record('item', 'update', args),
        shapeItem(args)
      ),
      createManyAndReturn: async (args: Record<string, any>) => (
        record('item', 'createManyAndReturn', args),
        [shapeItem(args)]
      ),
      deleteMany: async () => ({ count: 1 }),
    },
    product: {
      // The picture read of POST /api/history selects the legacy column on purpose (a transition
      // helper outside `src`); every other read gets the bare id.
      findMany: async (args: Record<string, any>) => (
        record('product', 'findMany', args),
        [
          args.select?.imageUrlEn
            ? {
                id: 'p1',
                imageUrl: productRow().imageUrl,
                imageTextLocale: null,
                localizedImages: productRow().localizedImages,
                imageUrlEn: LEGACY,
              }
            : { id: 'p1' },
        ]
      ),
    },
    listHistory: {
      create: async (args: Record<string, any>) => {
        record('listHistory', 'create', args);
        const omit = args.include?.items?.omit;
        return { id: 'hist-1', items: [withoutColumns(historyItemRow(), omit)] };
      },
    },
  };
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(makeTx()),
    list: {
      findFirst: async (args: Record<string, any>) => (
        record('list', 'findFirst', args),
        {
          id: 'list-1',
          userId: 'user-1',
          items: [shapeItem(args.include.items)],
          _count: { items: 1 },
        }
      ),
      findUnique: async (args: Row) => (record('list', 'findUnique', args), { id: 'list-1' }),
    },
    product: {
      findMany: async (args: Row) => (record('product', 'findMany', args), [{ id: 'p1' }]),
    },
    productVariant: { findMany: async () => [] },
    listHistory: {
      findMany: async (args: Record<string, any>) => (
        record('listHistory', 'findMany', args),
        [
          {
            id: 'hist-1',
            userId: 'user-1',
            listName: 'Покупки',
            items: [withoutColumns(historyItemRow(), args.include.items.omit)],
          },
        ]
      ),
    },
  },
}));

const listRoute = await import('./lists/[listId]/route');
const itemRoute = await import('./lists/[listId]/items/[itemId]/route');
const itemsRoute = await import('./lists/[listId]/items/route');
const historyRoute = await import('./history/route');

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  db.calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function expectNoLegacyColumn(body: unknown) {
  expect(JSON.stringify(body)).not.toMatch(/imageUrlEn|productImageUrlEn|legacy-only/);
}

describe('routes that serve products, variants and history rows', () => {
  it('GET /api/lists/[listId]: the product and the variant of every item', async () => {
    const response = await listRoute.GET(new Request('http://localhost/api/lists/list-1'), {
      params: Promise.resolve({ listId: 'list-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoLegacyColumn(body);
    expect(body.items[0].product.localizedImages).toEqual({
      en: 'https://utfs.io/f/dictionary-en',
    });
    expect(body.items[0].variant).toMatchObject({ id: 'v1', name: 'Красное' });
  });

  it('PUT /api/lists/[listId]/items/[itemId]: the product it returns', async () => {
    const response = await itemRoute.PUT(
      new Request('http://localhost/', { ...json({ note: 'two' }), method: 'PUT' }),
      { params: Promise.resolve({ listId: 'list-1', itemId: 'i1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoLegacyColumn(body);
    expect(body.product.localizedImages).toEqual({ en: 'https://utfs.io/f/dictionary-en' });
  });

  it('POST /api/lists/[listId]/items: the products of the created items', async () => {
    const response = await itemsRoute.POST(
      new Request('http://localhost/', json({ items: [{ productId: 'p1' }] })),
      { params: Promise.resolve({ listId: 'list-1' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoLegacyColumn(body);
    expect(body.createdItems[0].product.localizedImages).toEqual({
      en: 'https://utfs.io/f/dictionary-en',
    });
  });

  it('GET /api/history: the snapshot rows', async () => {
    const response = await historyRoute.GET(new Request('http://localhost/api/history'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoLegacyColumn(body);
    expect(body[0].items[0].localizedImages).toEqual({ en: 'https://utfs.io/f/dictionary-en' });
  });

  it('POST /api/history: the snapshot it returns, and the rows it reads to build it', async () => {
    const response = await historyRoute.POST(
      new Request('http://localhost/api/history', json({ listId: 'list-1' }))
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoLegacyColumn(body);
    // The rows read for the snapshot leave the column in the database too.
    const read = db.calls.find(({ model, op }) => model === 'item' && op === 'findMany')!;
    expect(read.args.include.product).toMatchObject({ omit: { imageUrlEn: true } });
    expect(read.args.include.variant).toMatchObject({ omit: { imageUrlEn: true } });
    // The legacy column the picture read selects is the source of the English entry (an old writer
    // may have changed it after the dictionary was filled): the snapshot carries that address in
    // its dictionary and its rollback column, and the response above carries no legacy field.
    const created = db.calls.find(({ model, op }) => model === 'listHistory' && op === 'create')!;
    const [row] = created.args.data.items.create;
    expect(row.localizedImages).toEqual({ en: LEGACY });
    expect(row.productImageUrlEn).toBe(LEGACY);
  });
});
