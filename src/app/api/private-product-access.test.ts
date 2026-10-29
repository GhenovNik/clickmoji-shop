// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The shared daily AI budget is covered by src/app/api/ai-daily-quota.test.ts.
vi.mock('@/lib/ai-quota', () => ({ enforceAiQuota: async () => null }));

// A product with isGlobal=false belongs to its creator only: GET /api/products and /api/search
// already hide it from everyone else. These tests pin the same rule on the routes that accept a
// product id or look a product up by name.

type ProductRow = {
  id: string;
  name: string;
  nameEn: string;
  isGlobal: boolean;
  createdById: string | null;
};

const PRODUCTS: ProductRow[] = [
  { id: 'global-1', name: 'Молоко', nameEn: 'Milk', isGlobal: true, createdById: null },
  {
    id: 'private-a',
    name: 'Сыр бабушки Ани',
    nameEn: 'Grandma Anya cheese',
    isGlobal: false,
    createdById: 'user-a',
  },
  { id: 'private-b', name: 'Мой хлеб', nameEn: 'My bread', isGlobal: false, createdById: 'user-b' },
];

// Minimal Prisma `where` semantics: field equality, `in`, OR and AND.
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') {
      return (value as Record<string, unknown>[]).some((clause) => matches(row, clause));
    }
    if (key === 'AND') {
      return (value as Record<string, unknown>[]).every((clause) => matches(row, clause));
    }
    if (value && typeof value === 'object' && 'in' in value) {
      return (value.in as unknown[]).includes(row[key]);
    }
    return row[key] === value;
  });
}

const findProduct = async ({ where }: { where: Record<string, unknown> }) =>
  PRODUCTS.find((row) => matches(row, where)) ?? null;

const doubles = vi.hoisted(() => ({
  requireUser: vi.fn(),
  analyzeSmartProduct: vi.fn(),
  parseShoppingListText: vi.fn(),
  createProduct: vi.fn(),
  createItem: vi.fn(),
  upsertFavorite: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({
  requireUser: doubles.requireUser,
  requireAdmin: doubles.requireUser,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    list: {
      findUnique: async () => ({ id: 'list-b', userId: 'user-b' }),
    },
    product: {
      findUnique: (args: { where: Record<string, unknown> }) => findProduct(args),
      findFirst: (args: { where: Record<string, unknown> }) => findProduct(args),
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        PRODUCTS.filter((row) => matches(row, where)),
      create: doubles.createProduct,
    },
    productVariant: { findUnique: async () => null, findMany: async () => [] },
    item: {
      create: doubles.createItem,
      createManyAndReturn: async ({ data }: { data: Array<{ productId: string }> }) =>
        Promise.all(data.map((row) => doubles.createItem({ data: row }))),
    },
    $transaction: async (run: (tx: unknown) => unknown) => {
      const { prisma } = await import('@/lib/prisma');
      return run(prisma);
    },
    favorite: { upsert: doubles.upsertFavorite },
    user: {
      findUnique: async () => ({ id: 'user-b', role: 'USER', createdProductsCount: 0 }),
      update: async () => ({}),
    },
    category: {
      findMany: async () => [{ id: 'cat-1', name: 'Молочное', nameEn: 'Dairy', order: 1 }],
    },
  },
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0 }) };
});

vi.mock('@/lib/services/ai-products', () => ({
  analyzeSmartProduct: doubles.analyzeSmartProduct,
  parseShoppingListText: doubles.parseShoppingListText,
}));

vi.mock('@/lib/services/emoji-assets', () => ({
  generateAndUploadEmojiAsset: async () => {
    throw new Error('emoji generation must not run in this test');
  },
}));

const itemsRoute = await import('@/app/api/lists/[listId]/items/route');
const favoritesRoute = await import('@/app/api/favorites/route');
const smartCreateRoute = await import('@/app/api/products/smart-create/route');
const importTextRoute = await import('@/app/api/lists/import-text/route');

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function addItems(productId: string) {
  return itemsRoute.POST(
    jsonRequest('http://localhost/api/lists/list-b/items', { items: [{ productId }] }),
    { params: Promise.resolve({ listId: 'list-b' }) }
  );
}

function addFavorite(productId: string) {
  return favoritesRoute.POST(jsonRequest('http://localhost/api/favorites', { productId }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.GOOGLE_GENAI_API_KEY = 'synthetic-google-genai-key-for-tests';
  doubles.requireUser.mockResolvedValue({ session: { user: { id: 'user-b', role: 'USER' } } });
  doubles.createItem.mockImplementation(async ({ data }: { data: { productId: string } }) => ({
    id: `item-${data.productId}`,
    ...data,
  }));
  doubles.upsertFavorite.mockImplementation(
    async ({ create }: { create: { productId: string } }) => ({ id: 'fav-1', ...create })
  );
  doubles.createProduct.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'new-product',
    ...data,
  }));
});

describe('POST /api/lists/[listId]/items', () => {
  it("rejects another user's private product", async () => {
    const response = await addItems('private-a');

    expect(response.status).toBe(404);
    expect(doubles.createItem).not.toHaveBeenCalled();
  });

  it('accepts a global product and the caller own private product', async () => {
    expect((await addItems('global-1')).status).toBe(200);
    expect((await addItems('private-b')).status).toBe(200);
    expect(doubles.createItem).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/favorites', () => {
  it("rejects another user's private product", async () => {
    const response = await addFavorite('private-a');

    expect(response.status).toBe(404);
    expect(doubles.upsertFavorite).not.toHaveBeenCalled();
  });

  it('accepts a global product and the caller own private product', async () => {
    expect((await addFavorite('global-1')).status).toBe(200);
    expect((await addFavorite('private-b')).status).toBe(200);
  });
});

describe('POST /api/products/smart-create duplicate lookup', () => {
  function smartCreate(nameRu: string, nameEn: string) {
    doubles.analyzeSmartProduct.mockResolvedValue({
      result: { nameRu, nameEn, categoryName: 'Dairy', emoji: '🧀', needsCustomEmoji: false },
      promptVersion: 'test',
      model: 'test',
    });
    return smartCreateRoute.POST(
      jsonRequest('http://localhost/api/products/smart-create', { productName: nameRu })
    );
  }

  it("does not return another user's private product as an existing match", async () => {
    const response = await smartCreate('Сыр бабушки Ани', 'Grandma Anya cheese');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.exists).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('private-a');
    expect(JSON.stringify(body)).not.toContain('user-a');
    expect(doubles.createProduct).toHaveBeenCalledTimes(1);
  });

  it('still returns a visible product as an existing match', async () => {
    const response = await smartCreate('Молоко', 'Milk');
    const body = await response.json();

    expect(body.exists).toBe(true);
    expect(body.product.id).toBe('global-1');
    expect(doubles.createProduct).not.toHaveBeenCalled();
  });
});

describe('POST /api/lists/import-text', () => {
  function importText(nameRu: string, nameEn: string) {
    doubles.parseShoppingListText.mockResolvedValue({
      products: [{ nameRu, nameEn, categoryName: 'Dairy', emoji: '🧀' }],
      promptVersion: 'test',
      model: 'test',
    });
    return importTextRoute.POST(
      jsonRequest('http://localhost/api/lists/import-text', { text: nameRu, listId: 'list-b' })
    );
  }

  it("does not add another user's private product matched by name", async () => {
    const response = await importText('Сыр бабушки Ани', 'Grandma Anya cheese');

    expect(response.status).toBe(200);
    expect(doubles.createItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productId: 'private-a' }) })
    );
    expect(doubles.createProduct).toHaveBeenCalledTimes(1);
  });

  it('creates a missing product as private to a regular user, like smart-create', async () => {
    await importText('Новый товар', 'New product');

    expect(doubles.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isGlobal: false, createdById: 'user-b' }),
      })
    );
  });

  it('creates a missing product as global for an administrator', async () => {
    doubles.requireUser.mockResolvedValue({ session: { user: { id: 'admin-1', role: 'ADMIN' } } });

    await importText('Новый товар', 'New product');

    expect(doubles.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isGlobal: true, createdById: 'admin-1' }),
      })
    );
  });

  it('reuses a visible product matched by name', async () => {
    await importText('Молоко', 'Milk');

    expect(doubles.createProduct).not.toHaveBeenCalled();
    expect(doubles.createItem).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productId: 'global-1' }) })
    );
  });
});
