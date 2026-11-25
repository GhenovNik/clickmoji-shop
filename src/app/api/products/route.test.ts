// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// AGE-1618: the catalog order depends on the interface language, but only the order —
// the response fields are the database rows untouched. Rows are fed in `name` order,
// like Postgres returns them for `orderBy: { name: 'asc' }`.

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  findMany: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    product: {
      findMany: (args: unknown) => state.findMany(args),
    },
  },
}));

const { GET } = await import('./route');

function row(id: string, name: string, nameEn: string | null) {
  return {
    id,
    name,
    nameEn,
    emoji: '🍎',
    categoryId: 'cat-1',
    isGlobal: true,
    createdById: null,
    imageUrl: null,
    localizedImages: null,
    variants: [],
    category: {
      id: 'cat-1',
      name: 'Фрукты',
      nameEn: 'Fruits',
      emoji: '🍏',
      isCustom: false,
      imageUrl: null,
    },
  };
}

const CATALOG = [
  row('watermelon', 'Арбуз', 'Watermelon'),
  row('banana', 'Банан', 'Banana'),
  row('cherry', 'Вишня', null),
  row('apple', 'Яблоко', 'Apple'),
];

function get(url: string, locale?: string) {
  return GET(
    new Request(url, {
      headers: locale ? { cookie: `NEXT_LOCALE=${locale}` } : {},
    })
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  state.rows = [...CATALOG];
  state.findMany.mockReset();
  state.findMany.mockImplementation(async () => [...state.rows]);
});

describe('GET /api/products ordering', () => {
  const branches = [
    ['full catalog', 'http://localhost/api/products'],
    ['category', 'http://localhost/api/products?categoryId=cat-1'],
  ] as const;

  it.each(branches)(
    'en: orders by displayed name, falling back to name (%s)',
    async (_label, url) => {
      const response = await get(url, 'en');
      const body = (await response.json()) as Array<{ id: string }>;

      expect(body.map((item) => item.id)).toEqual(['apple', 'banana', 'watermelon', 'cherry']);
    }
  );

  it.each(branches)('en: ignores case when comparing displayed names (%s)', async (_label, url) => {
    state.rows = [row('abricot', 'Абрикос', 'Avocado'), row('apple', 'Яблоко', 'apple')];

    const response = await get(url, 'en');
    const body = (await response.json()) as Array<{ id: string }>;

    expect(body.map((item) => item.id)).toEqual(['apple', 'abricot']);
  });

  it.each(branches)('ru: keeps the name order (%s)', async (_label, url) => {
    const response = await get(url, 'ru');
    const body = (await response.json()) as Array<{ id: string }>;

    expect(body.map((item) => item.id)).toEqual(['watermelon', 'banana', 'cherry', 'apple']);
  });

  it.each(branches)('returns the same fields and the same length (%s)', async (_label, url) => {
    const response = await get(url, 'en');
    const body = (await response.json()) as Array<Record<string, unknown>>;

    expect(body).toHaveLength(state.rows.length);
    for (const item of body) {
      expect(Object.keys(item).sort()).toEqual(Object.keys(CATALOG[0]).sort());
    }
  });
});

// AGE-1667 Ya3 review: the legacy English column is a write-only rollback mirror. A query that
// returns full rows must ask the database to leave it out, on the product and on its variants, in
// both branches. The fake database below applies `omit` the way Prisma does, so a branch that
// forgets one leaks the column into the response.
describe('GET /api/products does not return the legacy English column', () => {
  type Args = {
    omit?: Record<string, boolean>;
    include?: { variants?: true | { omit?: Record<string, boolean> } };
  };

  const without = (row: Record<string, unknown>, omit: Record<string, boolean> = {}) =>
    Object.fromEntries(Object.entries(row).filter(([column]) => !omit[column]));

  function databaseWithLegacyColumn() {
    state.findMany.mockImplementation(async (args: Args) =>
      state.rows.map((product) => {
        const variants = product.variants as Array<Record<string, unknown>>;
        const variantArgs = typeof args.include?.variants === 'object' ? args.include.variants : {};
        return {
          ...without(product, args.omit),
          variants: variants.map((variant) => without(variant, variantArgs.omit)),
        };
      })
    );
  }

  function withLegacy(id: string) {
    return {
      ...row(id, 'Яблоко', 'Apple'),
      imageUrlEn: 'https://utfs.io/f/legacy-en',
      localizedImages: { en: 'https://utfs.io/f/dictionary-en' },
      variants: [
        {
          id: 'v1',
          name: 'Красное',
          nameEn: 'Red',
          emoji: '🍎',
          imageUrl: null,
          imageUrlEn: 'https://utfs.io/f/variant-legacy-en',
          localizedImages: { en: 'https://utfs.io/f/variant-dictionary-en' },
        },
      ],
    };
  }

  it.each([
    ['full catalog', 'http://localhost/api/products'],
    ['category', 'http://localhost/api/products?categoryId=cat-1'],
  ])(
    '%s: neither the product nor its variants carry it, the dictionaries stay',
    async (_l, url) => {
      state.rows = [withLegacy('apple')];
      databaseWithLegacyColumn();

      const response = await get(url);
      const [product] = (await response.json()) as Array<Record<string, unknown>>;

      expect(response.status).toBe(200);
      expect(JSON.stringify(product)).not.toContain('imageUrlEn');
      expect(JSON.stringify(product)).not.toContain('legacy-en');
      expect(product).toMatchObject({
        id: 'apple',
        localizedImages: { en: 'https://utfs.io/f/dictionary-en' },
        category: { id: 'cat-1' },
        variants: [
          { id: 'v1', localizedImages: { en: 'https://utfs.io/f/variant-dictionary-en' } },
        ],
      });
    }
  );

  it.each([
    ['full catalog', 'http://localhost/api/products'],
    ['category', 'http://localhost/api/products?categoryId=cat-1'],
  ])('%s: the query itself omits the column on both levels', async (_l, url) => {
    await get(url);

    expect(state.findMany).toHaveBeenCalledTimes(1);
    expect(state.findMany.mock.calls[0]![0]).toMatchObject({
      omit: { imageUrlEn: true },
      include: { variants: { omit: { imageUrlEn: true } } },
    });
  });
});
