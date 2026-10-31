// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner report: pasting products that all exist in the catalog does not fill the list. The route
// and the AI response parsing run for real here; only the @google/genai SDK and the database are
// faked. The same scenarios run against PostgreSQL in import-text.integration.test.ts.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  reply: '',
  products: [] as Row[],
  items: [] as Row[],
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: async () => ({ text: state.reply }) };
  },
}));

vi.mock('@/lib/auth-guards', () => ({
  requireUser: async () => ({ session: { user: { id: 'user-b', role: 'USER' } } }),
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0 }) };
});

// The daily AI budget is covered by src/app/api/ai-daily-quota.test.ts.
vi.mock('@/lib/ai-quota', () => ({ enforceAiQuota: async () => null }));

vi.mock('@/lib/prisma', () => {
  // Prisma `where` subset used by the route: equality, `equals` with mode, OR and AND.
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return (value as Row[]).some((clause) => matches(row, clause));
      if (key === 'AND') return (value as Row[]).every((clause) => matches(row, clause));
      if (value && typeof value === 'object' && 'equals' in value) {
        const fold = (v: unknown) =>
          (value as Row).mode === 'insensitive' ? String(v).toLowerCase() : v;
        return fold(row[key]) === fold((value as Row).equals);
      }
      return row[key] === value;
    });
  let sequence = 0;
  return {
    prisma: {
      list: { findUnique: async () => ({ id: 'list-b', userId: 'user-b' }) },
      category: {
        findMany: async () => [
          { id: 'cat-dairy', name: 'Молочные продукты', nameEn: 'Dairy', order: 1 },
          { id: 'cat-bakery', name: 'Хлеб и выпечка', nameEn: 'Bread & Bakery', order: 2 },
        ],
      },
      product: {
        findFirst: async ({ where }: { where: Row }) =>
          state.products.find((row) => matches(row, where)) ?? null,
        findMany: async ({ where }: { where: Row }) =>
          state.products.filter((row) => matches(row, where)),
        create: async ({ data }: { data: Row }) => {
          const row = { id: `new-${++sequence}`, ...data };
          state.products.push(row);
          return row;
        },
      },
      item: {
        create: async ({ data }: { data: Row }) => {
          state.items.push(data);
          return data;
        },
      },
    },
  };
});

const { POST } = await import('./route');

const catalogProduct = (id: string, name: string, nameEn: string, categoryId: string) => ({
  id,
  name,
  nameEn,
  categoryId,
  isGlobal: true,
  createdById: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

async function runImport(reply: unknown[]) {
  state.reply = JSON.stringify(reply);
  const response = await POST(
    new Request('http://localhost/api/lists/import-text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Молоко\nЯйца\nХлеб белый', listId: 'list-b' }),
    })
  );
  return {
    status: response.status,
    body: await response.json(),
    addedProductIds: state.items.map((item) => item.productId),
    createdProducts: state.products.filter((row) => row.createdById === 'user-b').length,
  };
}

const milk = { nameRu: 'Молоко', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' };
const eggs = { nameRu: 'Яйца', nameEn: 'Eggs', categoryName: 'Dairy', emoji: '🥚' };
const bread = {
  nameRu: 'Хлеб белый',
  nameEn: 'White Bread',
  categoryName: 'Bread & Bakery',
  emoji: '🍞',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.GOOGLE_GENAI_API_KEY = 'synthetic-google-genai-key-for-tests';
  state.items = [];
  state.products = [
    catalogProduct('milk', 'Молоко', 'Milk', 'cat-dairy'),
    catalogProduct('eggs', 'Яйца', 'Eggs', 'cat-dairy'),
    catalogProduct('bread', 'Хлеб белый', 'White Bread', 'cat-bakery'),
  ];
});

describe('POST /api/lists/import-text with products that exist in the catalog', () => {
  it('adds them when the model echoes the catalog names exactly', async () => {
    const result = await runImport([milk, eggs, bread]);

    expect(result.status).toBe(200);
    expect(result.addedProductIds).toEqual(['milk', 'eggs', 'bread']);
    expect(result.createdProducts).toBe(0);
  });

  it('adds them when the category comes back in the form the prompt lists it', async () => {
    const result = await runImport([
      { ...milk, categoryName: 'Dairy (Молочные продукты)' },
      { ...eggs, categoryName: 'dairy' },
      { ...bread, categoryName: 'Хлеб и выпечка' },
    ]);

    expect(result.status).toBe(200);
    expect(result.body.results.failed).toEqual([]);
    expect(result.addedProductIds).toEqual(['milk', 'eggs', 'bread']);
  });

  it('adds an existing product whose category the model got wrong', async () => {
    const result = await runImport([{ ...milk, categoryName: 'Beverages' }]);

    expect(result.addedProductIds).toEqual(['milk']);
    expect(result.createdProducts).toBe(0);
  });

  it('reuses the catalog product despite different letter case or spaces', async () => {
    const result = await runImport([{ ...milk, nameRu: ' молоко ', nameEn: 'MILK' }]);

    expect(result.addedProductIds).toEqual(['milk']);
    expect(result.createdProducts).toBe(0);
  });

  it('keeps the valid entries and reports a malformed one as failed', async () => {
    const result = await runImport([
      milk,
      { nameRu: '???', nameEn: '', categoryName: 'Dairy', emoji: '' },
      eggs,
    ]);

    expect(result.status).toBe(200);
    expect(result.addedProductIds).toEqual(['milk', 'eggs']);
    expect(result.body.results.failed).toEqual([
      {
        product: { nameRu: '???', nameEn: 'Unrecognized item' },
        reason: 'Unrecognized entry in the AI response',
      },
    ]);
  });

  it('reports malformed entries as a strings-only DTO with fallback names', async () => {
    const result = await runImport([
      milk,
      { nameRu: { text: 'Сыр' }, nameEn: ['Cheese'], categoryName: 'Dairy', emoji: 7 },
      'just a string',
    ]);

    expect(result.status).toBe(200);
    expect(result.addedProductIds).toEqual(['milk']);
    const unrecognized = {
      product: { nameRu: 'Нераспознанная позиция', nameEn: 'Unrecognized item' },
      reason: 'Unrecognized entry in the AI response',
    };
    expect(result.body.results.failed).toEqual([unrecognized, unrecognized]);
  });
});

describe('POST /api/lists/import-text with unknown products', () => {
  it('creates only the unknown product, privately, and adds all of them', async () => {
    const result = await runImport([
      milk,
      { nameRu: 'Тархун', nameEn: 'Tarragon soda', categoryName: 'Dairy', emoji: '🥤', note: '2' },
    ]);

    expect(result.status).toBe(200);
    const created = state.products.at(-1);
    expect(created).toMatchObject({ name: 'Тархун', isGlobal: false, createdById: 'user-b' });
    expect(result.addedProductIds).toEqual(['milk', created?.id]);
    expect(result.createdProducts).toBe(1);
  });

  it('reports an unknown product with an unknown category as failed and adds the rest', async () => {
    const result = await runImport([
      milk,
      { nameRu: 'Тархун', nameEn: 'Tarragon soda', categoryName: 'Beverages', emoji: '🥤' },
    ]);

    expect(result.addedProductIds).toEqual(['milk']);
    // Failed valid entries use the same strings-only DTO: no emoji, note or category echoed.
    expect(result.body.results.failed).toEqual([
      {
        product: { nameRu: 'Тархун', nameEn: 'Tarragon soda' },
        reason: 'Category "Beverages" not found',
      },
    ]);
  });
});
