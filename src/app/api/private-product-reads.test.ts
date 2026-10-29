// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Rows written before the write paths enforced product visibility can still reference another
// user's private product (user B holding user A's "private-a"). These tests pin that every read
// path hides such legacy references and that restore does not recreate them, while the caller's
// own private products and global products stay visible.

type Row = Record<string, unknown>;

const PRODUCTS: Row[] = [
  { id: 'global-1', name: 'Молоко', isGlobal: true, createdById: null, category: { name: 'C' } },
  {
    id: 'private-a',
    name: 'Сыр бабушки Ани',
    isGlobal: false,
    createdById: 'user-a',
    category: { name: 'C' },
  },
  {
    id: 'private-b',
    name: 'Мой хлеб',
    isGlobal: false,
    createdById: 'user-b',
    category: { name: 'C' },
  },
];

const ITEMS: Row[] = [
  { id: 'item-global', listId: 'list-b', productId: 'global-1', variantId: null },
  { id: 'item-legacy', listId: 'list-b', productId: 'private-a', variantId: null },
  { id: 'item-own', listId: 'list-b', productId: 'private-b', variantId: null },
];

const FAVORITES: Row[] = ['global-1', 'private-a', 'private-b'].map((productId) => ({
  id: `fav-${productId}`,
  userId: 'user-b',
  productId,
}));

const HISTORY_ITEMS: Row[] = [
  { id: 'h-global', productId: 'global-1', variantId: null, productName: 'Молоко' },
  { id: 'h-legacy', productId: 'private-a', variantId: null, productName: 'Сыр бабушки Ани' },
  { id: 'h-own', productId: 'private-b', variantId: null, productName: 'Мой хлеб' },
  { id: 'h-deleted', productId: 'deleted-product', variantId: null, productName: 'Старый' },
  { id: 'h-null', productId: null, variantId: null, productName: 'Без ссылки' },
];

const productOf = (row: Row) => PRODUCTS.find((product) => product.id === row.productId) ?? null;

// Minimal Prisma `where` semantics: equality, `in`, OR/AND/NOT and the `product` relation.
function matches(row: Row | null, where: Row): boolean {
  if (!row) return false;
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Row[]).some((clause) => matches(row, clause));
    if (key === 'AND') return (value as Row[]).every((clause) => matches(row, clause));
    if (key === 'NOT') return !matches(row, value as Row);
    if (key === 'product') return matches(productOf(row), value as Row);
    if (value && typeof value === 'object' && 'in' in value) {
      return (value.in as unknown[]).includes(row[key]);
    }
    return row[key] === value;
  });
}

const withProduct = (row: Row) => ({ ...row, product: productOf(row), variant: null });

function listItems(include: { items?: { where?: Row }; _count?: { select: { items: unknown } } }) {
  const itemsWhere = include.items?.where ?? {};
  const countSelect = include._count?.select.items;
  const countWhere = typeof countSelect === 'object' ? ((countSelect as Row).where as Row) : {};
  const inList = ITEMS.filter((item) => item.listId === 'list-b');
  return {
    items: inList.filter((item) => matches(item, itemsWhere)).map(withProduct),
    _count: { items: inList.filter((item) => matches(item, countWhere)).length },
  };
}

const LIST = { id: 'list-b', userId: 'user-b', name: 'Покупки', isActive: true };

const doubles = vi.hoisted(() => ({
  requireUser: vi.fn(),
  updateItem: vi.fn(),
  createHistory: vi.fn(),
  createItems: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({
  requireUser: doubles.requireUser,
  requireAdmin: doubles.requireUser,
}));

vi.mock('@/lib/prisma', () => {
  const prisma = {
    list: {
      findFirst: async ({ include }: { include: Parameters<typeof listItems>[0] }) => ({
        ...LIST,
        ...listItems(include),
      }),
      findUnique: async ({ include }: { include?: Parameters<typeof listItems>[0] }) => ({
        ...LIST,
        ...(include ? listItems(include) : {}),
      }),
      findMany: async ({ include }: { include: Parameters<typeof listItems>[0] }) => [
        { ...LIST, ...listItems(include) },
      ],
      create: async ({ data }: { data: Row }) => ({ id: 'restored-list', ...data }),
    },
    item: {
      findFirst: async ({ where }: { where: Row }) =>
        ITEMS.find((item) => matches(item, where)) ?? null,
      findUnique: async ({ where }: { where: Row }) =>
        ITEMS.find((item) => matches(item, where)) ?? null,
      update: doubles.updateItem,
      deleteMany: async () => ({ count: 0 }),
      createMany: doubles.createItems,
    },
    favorite: {
      findMany: async ({ where }: { where: Row }) =>
        FAVORITES.filter((favorite) => matches(favorite, where)).map(withProduct),
    },
    product: {
      findMany: async ({ where }: { where: Row }) =>
        PRODUCTS.filter((product) => matches(product, where)).map(({ id }) => ({ id })),
    },
    productVariant: { findMany: async () => [] },
    listHistory: {
      findMany: async () => [{ id: 'history-b', userId: 'user-b', items: HISTORY_ITEMS }],
      findUnique: async () => ({
        id: 'history-b',
        userId: 'user-b',
        listName: 'Покупки',
        items: HISTORY_ITEMS,
      }),
      create: doubles.createHistory,
    },
    $transaction: async (run: (tx: unknown) => unknown) => run(prisma),
  };
  return { prisma };
});

const favoritesRoute = await import('@/app/api/favorites/route');
const listRoute = await import('@/app/api/lists/[listId]/route');
const listsRoute = await import('@/app/api/lists/route');
const itemRoute = await import('@/app/api/lists/[listId]/items/[itemId]/route');
const historyRoute = await import('@/app/api/history/route');
const restoreRoute = await import('@/app/api/history/[historyId]/restore/route');

const productIds = (rows: Row[]) => rows.map((row) => row.productId);

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  doubles.requireUser.mockResolvedValue({ session: { user: { id: 'user-b', role: 'USER' } } });
  doubles.updateItem.mockImplementation(async ({ where }: { where: Row }) =>
    withProduct(ITEMS.find((item) => item.id === where.id) as Row)
  );
  doubles.createHistory.mockImplementation(async ({ data }: { data: Row }) => ({
    id: 'new-history',
    items: (data.items as { create: Row[] }).create,
  }));
  doubles.createItems.mockResolvedValue({ count: 0 });
});

describe('GET /api/favorites', () => {
  it("hides a legacy favorite of another user's private product", async () => {
    const body = await (await favoritesRoute.GET()).json();

    expect(productIds(body)).toEqual(['global-1', 'private-b']);
    expect(JSON.stringify(body)).not.toContain('private-a');
  });
});

describe('GET /api/lists/[listId]', () => {
  it("hides a legacy item of another user's private product and its count", async () => {
    const response = await listRoute.GET(new Request('http://localhost/api/lists/list-b'), {
      params: Promise.resolve({ listId: 'list-b' }),
    });
    const body = await response.json();

    expect(productIds(body.items)).toEqual(['global-1', 'private-b']);
    expect(body._count.items).toBe(2);
    expect(JSON.stringify(body)).not.toContain('Сыр бабушки Ани');
  });
});

describe('GET /api/lists', () => {
  it('counts only visible items', async () => {
    const body = await (await listsRoute.GET()).json();

    expect(body[0]._count.items).toBe(2);
  });
});

describe('PUT /api/lists/[listId]/items/[itemId]', () => {
  function updateItem(itemId: string) {
    return itemRoute.PUT(
      jsonRequest(`http://localhost/api/lists/list-b/items/${itemId}`, 'PUT', {
        isPurchased: true,
      }),
      { params: Promise.resolve({ listId: 'list-b', itemId }) }
    );
  }

  it("does not update or return a legacy item of another user's private product", async () => {
    const response = await updateItem('item-legacy');

    expect(response.status).toBe(404);
    expect(doubles.updateItem).not.toHaveBeenCalled();
  });

  it('updates an item of a global product and of the caller own private product', async () => {
    expect((await updateItem('item-global')).status).toBe(200);
    expect((await updateItem('item-own')).status).toBe(200);
  });
});

describe('POST /api/history (complete a list)', () => {
  it("does not copy another user's private product into the history snapshot", async () => {
    const response = await historyRoute.POST(
      jsonRequest('http://localhost/api/history', 'POST', { listId: 'list-b' })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(productIds(body.items)).toEqual(['global-1', 'private-b']);
  });
});

describe('GET /api/history', () => {
  // A snapshot item carries no provenance of its own, so access is only confirmed while its
  // product exists and is visible. A missing product is not treated as permission.
  it("hides snapshot items of another user's private product", async () => {
    const body = await (await historyRoute.GET()).json();

    expect(productIds(body[0].items)).toEqual(['global-1', 'private-b']);
    expect(JSON.stringify(body)).not.toContain('Сыр бабушки Ани');
  });

  it("keeps hiding another user's private snapshot after that product is deleted", async () => {
    const index = PRODUCTS.findIndex((product) => product.id === 'private-a');
    const [deleted] = PRODUCTS.splice(index, 1);
    try {
      const body = await (await historyRoute.GET()).json();

      expect(productIds(body[0].items)).toEqual(['global-1', 'private-b']);
      expect(JSON.stringify(body)).not.toContain('Сыр бабушки Ани');
    } finally {
      PRODUCTS.splice(index, 0, deleted);
    }
  });

  it('hides snapshot items without a product or with a deleted product', async () => {
    const body = await (await historyRoute.GET()).json();
    const names = body[0].items.map((item: Row) => item.productName);

    expect(names).not.toContain('Старый');
    expect(names).not.toContain('Без ссылки');
  });

  it("returns the caller's own private and global snapshot items", async () => {
    const body = await (await historyRoute.GET()).json();
    const names = body[0].items.map((item: Row) => item.productName);

    expect(names).toEqual(['Молоко', 'Мой хлеб']);
  });
});

describe('POST /api/history/[historyId]/restore', () => {
  it("does not recreate an item of another user's private product", async () => {
    const response = await restoreRoute.POST(
      jsonRequest('http://localhost/api/history/history-b/restore', 'POST', {}),
      { params: Promise.resolve({ historyId: 'history-b' }) }
    );
    const body = await response.json();
    const created = doubles.createItems.mock.calls[0]?.[0] as { data: Row[] };

    expect(response.status).toBe(200);
    expect(productIds(created.data)).toEqual(['global-1', 'private-b']);
    expect(body.createdCount).toBe(2);
  });
});
