// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// AGE-1618 В: the catalog order depends on the interface language, but only the order —
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
    imageUrlEn: null,
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
