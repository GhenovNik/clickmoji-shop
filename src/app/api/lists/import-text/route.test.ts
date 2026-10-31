// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner report: pasting products that all exist in the catalog does not fill the list. The route
// and the AI response parsing run for real here; only the @google/genai SDK and the database are
// faked. The same scenarios run against PostgreSQL in import-text.integration.test.ts.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  reply: '',
  prompts: [] as string[],
  products: [] as Row[],
  items: [] as Row[],
  failCatalog: false,
  failCreate: false,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async ({ contents }: { contents: string }) => {
        state.prompts.push(contents);
        return { text: state.reply };
      },
    };
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
        findMany: async ({ where }: { where: Row }) => {
          if (state.failCatalog) throw new Error('catalog read failed');
          return state.products.filter((row) => matches(row, where));
        },
        create: async ({ data }: { data: Row }) => {
          if (state.failCreate) throw new Error('insert refused');
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

async function runImportText(reply: string, text = 'Молоко\nЯйца\nХлеб белый') {
  state.reply = reply;
  const response = await POST(
    new Request('http://localhost/api/lists/import-text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, listId: 'list-b' }),
    })
  );
  return {
    status: response.status,
    body: await response.json(),
    addedProductIds: state.items.map((item) => item.productId),
    itemNotes: state.items.map((item) => item.note),
    createdProducts: state.products.filter((row) => row.createdById === 'user-b').length,
    prompt: state.prompts.at(-1) ?? '',
  };
}

const runImport = (reply: unknown[], text?: string) => runImportText(JSON.stringify(reply), text);

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
  state.prompts = [];
  state.items = [];
  state.failCatalog = false;
  state.failCreate = false;
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

describe('catalog-aware text import prompt', () => {
  it('shows the visible catalog and the category hints without a translate-to-Russian task', async () => {
    const result = await runImport([milk]);

    expect(result.prompt).toContain('- milk | Молоко | Milk | Молочные продукты');
    expect(result.prompt).toContain('existingProductId');
    expect(result.prompt).toContain('Dairy (Молочные продукты) — milk, cream, sour cream');
    expect(result.prompt).toContain('food and drinks never belong to a pharmacy');
    expect(result.prompt).toMatch(/сметана, сливки, кефир -> 🥛/);
    expect(result.prompt).not.toMatch(/translate each product/i);
    expect(result.prompt).not.toContain(
      'Translate each product to Russian (nameRu) and English (nameEn)'
    );
  });

  it('reuses the catalog product returned by id', async () => {
    const result = await runImport([{ existingProductId: 'bread', note: '1 батон' }], 'Хлеб');

    expect(result.status).toBe(200);
    expect(result.addedProductIds).toEqual(['bread']);
    expect(result.itemNotes).toEqual(['1 батон']);
    expect(result.createdProducts).toBe(0);
  });

  it('ignores an id outside the visible catalog and matches the name instead', async () => {
    const result = await runImport([{ existingProductId: 'ghost-id', nameRu: 'Молоко' }], 'Молоко');

    expect(result.status).toBe(200);
    expect(result.addedProductIds).toEqual(['milk']);
    expect(result.createdProducts).toBe(0);
  });
});

describe('no double translation and quantity notes', () => {
  it('creates "сметана 20%" as "Сметана" with the closest dairy emoji 🥛 and the note "20%"', async () => {
    const result = await runImport(
      [{ nameRu: 'сметана 20%', nameEn: 'Sour cream', categoryName: 'Dairy', emoji: '🥛' }],
      'сметана 20%'
    );

    expect(result.status).toBe(200);
    expect(result.createdProducts).toBe(1);
    const created = state.products.at(-1);
    expect(created).toMatchObject({
      name: 'Сметана',
      nameEn: 'Sour cream',
      emoji: '🥛',
      categoryId: 'cat-dairy',
    });
    expect(result.itemNotes).toEqual(['20%']);
    expect(result.addedProductIds).toEqual([created?.id]);
  });

  it('turns "сливки 33%" into "Сливки" with note "33%", never "Крем"', async () => {
    const result = await runImport(
      [{ nameRu: 'сливки 33%', nameEn: 'Cream', categoryName: 'Dairy', emoji: '🥛' }],
      'сливки 33%'
    );

    const created = state.products.at(-1);
    expect(created).toMatchObject({ name: 'Сливки', categoryId: 'cat-dairy' });
    expect(created?.name).not.toBe('Крем');
    expect(result.itemNotes).toEqual(['33%']);
  });

  it('reuses the catalog "Молоко" when the model writes "Молоко 2.5%"', async () => {
    const result = await runImport(
      [{ nameRu: 'Молоко 2.5%', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' }],
      'Молоко 2.5%'
    );

    expect(result.status).toBe(200);
    expect(result.addedProductIds).toEqual(['milk']);
    expect(result.itemNotes).toEqual(['2.5%']);
    expect(result.createdProducts).toBe(0);
  });

  it('keeps the box placeholder only when the model returned no valid emoji', async () => {
    const result = await runImport(
      [{ nameRu: 'сметана', nameEn: 'Sour cream', categoryName: 'Dairy', emoji: 'not-an-emoji' }],
      'сметана'
    );

    expect(state.products.at(-1)).toMatchObject({ emoji: '📦' });
    expect(result.createdProducts).toBe(1);
  });
});

describe('import failure paths', () => {
  it('answers 500 without a provider call when the visible catalog cannot be read', async () => {
    state.failCatalog = true;

    const result = await runImport([milk]);

    expect(result.status).toBe(500);
    expect(state.prompts).toEqual([]);
    expect(state.items).toEqual([]);
  });

  it('reports a provider reply that is not a JSON array as 500 and adds nothing', async () => {
    const result = await runImportText('not-json');

    expect(result.status).toBe(500);
    expect(state.items).toEqual([]);
  });

  it('reports a refused product insert for that entry and keeps the rest', async () => {
    state.failCreate = true;

    const result = await runImport(
      [{ nameRu: 'Сметана', nameEn: 'Sour cream', categoryName: 'Dairy', emoji: '🥛' }, milk],
      'сметана\nМолоко'
    );

    expect(result.status).toBe(200);
    expect(result.addedProductIds).toEqual(['milk']);
    expect(result.body.results.failed).toEqual([
      {
        product: { nameRu: 'Сметана', nameEn: 'Sour cream' },
        reason: 'insert refused',
      },
    ]);
  });
});
