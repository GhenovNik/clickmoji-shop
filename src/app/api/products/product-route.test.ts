// @vitest-environment node
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Product updates and deletes never remove picture files from UploadThing: a check followed by
// a delete races with a request that attaches the same URL again. Leftover files are left to the
// offline cleanup, run with the app stopped (AGE-1472).

type Pictures = {
  imageUrl: string | null;
  imageUrlEn?: string | null;
  localizedImages?: unknown;
  name?: string;
};

const state = vi.hoisted(() => ({
  products: new Map<string, Pictures>(),
  deleted: [] as string[],
  // Raw statements that took a row lock, in order.
  locks: [] as string[],
  // Makes the variants step of an update fail, after the product row was written.
  failVariants: false,
  // What each product.update was asked to write, to see which columns a request touched.
  writes: [] as Array<Record<string, unknown>>,
  // The arguments of every product query, to see what the route asked the database to return.
  queries: [] as Array<{ op: string; args: Record<string, unknown> }>,
}));

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => ({ session: { user: { id: 'admin-1', role: 'ADMIN' } } }),
}));

vi.mock('uploadthing/server', () => ({
  UTApi: class {
    deleteFiles = async (key: string) => {
      state.deleted.push(key);
    };
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    product: {
      delete: async ({ where }: { where: { id: string } }) => state.products.delete(where.id),
    },
    // A transaction that really rolls back: what the work wrote is undone when it throws.
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const before = new Map([...state.products].map(([id, row]) => [id, { ...row }]));
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
          state.locks.push(strings.join('?'));
          return [];
        },
        product: {
          update: async (args: { where: { id: string }; data: Partial<Pictures> }) => {
            const { where, data } = args;
            state.queries.push({ op: 'update', args });
            state.writes.push(data as Record<string, unknown>);
            const next = { ...state.products.get(where.id)!, ...data };
            state.products.set(where.id, next);
            return next;
          },
          findUnique: async (args: { where: { id: string } }) => {
            state.queries.push({ op: 'findUnique', args });
            return state.products.get(args.where.id);
          },
        },
        productVariant: {
          findMany: async () => {
            if (state.failVariants) throw new Error('variants step failed');
            return [];
          },
        },
      };
      try {
        return await work(tx);
      } catch (error) {
        state.products = before;
        throw error;
      }
    },
  },
}));

const route = await import('@/app/api/products/[productId]/route');
const { planRow } = await import('../../../../scripts/lib/localized-pictures-backfill');

function put(productId: string, body: Record<string, unknown>) {
  return route.PUT(
    new Request(`http://localhost:3000/api/products/${productId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ productId }) }
  );
}

const X = 'https://utfs.io/f/legacy-X';

beforeEach(() => {
  state.products = new Map([
    ['a', { imageUrl: X, imageUrlEn: null, localizedImages: null }],
    ['b', { imageUrl: null, imageUrlEn: null, localizedImages: null }],
  ]);
  state.deleted.length = 0;
  state.locks.length = 0;
  state.writes.length = 0;
  state.queries.length = 0;
  state.failVariants = false;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('product picture files', () => {
  it('keeps a replaced file that a stale form attaches to another product', async () => {
    // A replaces X; B, from a form opened earlier, saves X as its picture.
    expect((await put('a', { imageUrl: 'https://utfs.io/f/new' })).status).toBe(200);
    expect((await put('b', { imageUrl: X })).status).toBe(200);

    expect(state.deleted).toEqual([]);
    expect(state.products.get('b')?.imageUrl).toBe(X);
  });

  it('does not delete files when a product loses both pictures', async () => {
    state.products.set('a', {
      imageUrl: X,
      imageUrlEn: 'https://utfs.io/f/x-en',
      localizedImages: { en: 'https://utfs.io/f/x-en' },
    });

    await put('a', { imageUrl: null, localizedImages: { en: null } });

    expect(state.deleted).toEqual([]);
  });

  it('stores every listed picture language and mirrors English into the legacy column', async () => {
    await put('b', {
      imageUrl: X,
      localizedImages: { en: 'https://utfs.io/f/x-en', ru: 'https://utfs.io/f/x-ru' },
    });

    expect(state.products.get('b')).toEqual({
      imageUrl: X,
      imageUrlEn: 'https://utfs.io/f/x-en',
      localizedImages: { en: 'https://utfs.io/f/x-en', ru: 'https://utfs.io/f/x-ru' },
    });
  });

  it('keeps the entries of a language outside the list when English is removed', async () => {
    state.products.set('a', {
      imageUrl: X,
      imageUrlEn: 'https://utfs.io/f/x-en',
      localizedImages: { en: 'https://utfs.io/f/x-en', es: 'https://utfs.io/f/x-es' },
    });

    // The form shows only the listed languages: removing English must not touch Spanish.
    await put('a', { imageUrl: X, localizedImages: { en: null } });

    expect(state.products.get('a')).toMatchObject({
      imageUrlEn: null,
      localizedImages: { es: 'https://utfs.io/f/x-es' },
    });
  });

  it('ignores an edit of a language outside the list', async () => {
    state.products.set('a', {
      imageUrl: X,
      imageUrlEn: null,
      localizedImages: { es: 'https://utfs.io/f/x-es' },
    });

    await put('a', {
      localizedImages: { es: 'https://utfs.io/f/replaced', fr: 'https://utfs.io/f/x-fr' },
    });

    expect(state.products.get('a')?.localizedImages).toEqual({ es: 'https://utfs.io/f/x-es' });
  });

  it('leaves the dictionary alone when the request does not mention it', async () => {
    state.products.set('a', {
      imageUrl: X,
      imageUrlEn: 'https://utfs.io/f/x-en',
      localizedImages: { en: 'https://utfs.io/f/x-en', es: 'https://utfs.io/f/x-es' },
    });

    await put('a', { name: 'Кефир' });

    expect(state.products.get('a')).toMatchObject({
      imageUrlEn: 'https://utfs.io/f/x-en',
      localizedImages: { en: 'https://utfs.io/f/x-en', es: 'https://utfs.io/f/x-es' },
    });
    expect(state.locks).toEqual([]);
  });

  it('stores SQL NULL when the edit empties the dictionary', async () => {
    state.products.set('a', {
      imageUrl: X,
      imageUrlEn: 'https://utfs.io/f/x-en',
      localizedImages: { en: 'https://utfs.io/f/x-en' },
    });

    await put('a', { imageUrl: X, localizedImages: { en: null } });

    expect(state.products.get('a')).toMatchObject({
      imageUrlEn: null,
      localizedImages: Prisma.DbNull,
    });
  });
});

// AGE-1667 Ya3 review: the previous release writes the legacy English column only, so a product
// can hold its English address there while the dictionary has none. An ordinary save must not lose
// that address before the backfill copies it, and an explicit removal must stay removed.
describe('a product whose English picture only the legacy column holds', () => {
  const LEGACY_EN = 'https://utfs.io/f/legacy-en';
  const legacyOnly = (): Pictures => ({
    imageUrl: X,
    imageUrlEn: LEGACY_EN,
    localizedImages: { ru: 'https://utfs.io/f/x-ru' },
    name: 'Яблоко',
  });

  // What the repeat backfill would do with the row as it stands now (the Ya2 tool, run again).
  function backfillWouldWrite(id: string) {
    const row = state.products.get(id)!;
    return planRow(
      {
        id,
        main: row.imageUrl,
        en: row.imageUrlEn ?? null,
        textLocale: null,
        localized: row.localizedImages === Prisma.DbNull ? null : row.localizedImages,
      },
      new Map()
    );
  }

  beforeEach(() => {
    state.products.set('a', legacyOnly());
  });

  it('keeps the address through an ordinary edit, so the repeat backfill still finds it', async () => {
    // The form sends its name and no picture language (it cannot see the legacy address).
    expect((await put('a', { name: 'Яблоко красное', localizedImages: {} })).status).toBe(200);

    expect(state.products.get('a')).toMatchObject({
      name: 'Яблоко красное',
      imageUrlEn: LEGACY_EN,
    });
    // Not even named in the write: the mirror column and the dictionary were not part of it.
    expect(state.writes[0]).not.toHaveProperty('imageUrlEn');
    expect(state.writes[0]).not.toHaveProperty('localizedImages');
    expect(backfillWouldWrite('a')).toMatchObject({
      localizedImages: { ru: 'https://utfs.io/f/x-ru', en: LEGACY_EN },
    });
  });

  it('keeps the address when another language is edited', async () => {
    await put('a', { localizedImages: { ru: 'https://utfs.io/f/x-ru-new' } });

    expect(state.products.get('a')).toMatchObject({
      imageUrlEn: LEGACY_EN,
      localizedImages: { ru: 'https://utfs.io/f/x-ru-new' },
    });
    expect(state.writes[0]).not.toHaveProperty('imageUrlEn');
    expect(backfillWouldWrite('a')).toMatchObject({
      localizedImages: { ru: 'https://utfs.io/f/x-ru-new', en: LEGACY_EN },
    });
  });

  it('keeps the address when the request carries no picture edit that can be read', async () => {
    for (const localizedImages of [null, 'en', [LEGACY_EN]]) {
      await put('a', { name: 'Яблоко', localizedImages });
    }

    expect(state.products.get('a')).toMatchObject({ imageUrlEn: LEGACY_EN });
    expect(state.writes.every((write) => !('imageUrlEn' in write))).toBe(true);
  });

  it('removes both the mirror and the dictionary entry on an explicit English removal, for good', async () => {
    await put('a', { localizedImages: { en: null } });

    expect(state.products.get('a')).toMatchObject({
      imageUrlEn: null,
      localizedImages: { ru: 'https://utfs.io/f/x-ru' },
    });
    // The backfill finds nothing to copy: the removed picture is not brought back.
    expect(backfillWouldWrite('a')).toBeNull();
  });

  it('removes a dictionary English entry and its mirror together', async () => {
    state.products.set('a', {
      ...legacyOnly(),
      imageUrlEn: LEGACY_EN,
      localizedImages: { en: LEGACY_EN },
    });

    await put('a', { localizedImages: { en: null } });

    expect(state.products.get('a')).toMatchObject({
      imageUrlEn: null,
      localizedImages: Prisma.DbNull,
    });
    expect(backfillWouldWrite('a')).toBeNull();
  });

  it('replaces the legacy address with a new English picture in both places', async () => {
    await put('a', { localizedImages: { en: 'https://utfs.io/f/new-en' } });

    expect(state.products.get('a')).toMatchObject({
      imageUrlEn: 'https://utfs.io/f/new-en',
      localizedImages: { ru: 'https://utfs.io/f/x-ru', en: 'https://utfs.io/f/new-en' },
    });
    expect(backfillWouldWrite('a')).toBeNull();
  });

  it('ends in the same state when the same request is sent again (a retry)', async () => {
    const body = { name: 'Яблоко 2', localizedImages: { ru: 'https://utfs.io/f/x-ru-2' } };
    await put('a', body);
    const afterFirst = structuredClone(state.products.get('a'));
    await put('a', body);
    expect(state.products.get('a')).toEqual(afterFirst);

    await put('a', { localizedImages: { en: null } });
    const removed = structuredClone(state.products.get('a'));
    await put('a', { localizedImages: { en: null } });
    expect(state.products.get('a')).toEqual(removed);
  });

  it('locks the row before it reads the dictionary it rewrites', async () => {
    await put('a', { localizedImages: { ru: 'https://utfs.io/f/x-ru-2' } });

    expect(state.locks).toHaveLength(1);
    expect(state.locks[0]).toMatch(/FROM products WHERE id = \? FOR UPDATE/);
  });

  it('saves nothing of the picture edit when a later step of the same save fails', async () => {
    state.failVariants = true;

    const response = await put('a', {
      name: 'Яблоко 3',
      localizedImages: { en: null, ru: 'https://utfs.io/f/x-ru-3' },
      variants: [],
    });

    expect(response.status).toBe(500);
    // The product row was written before the variants step threw; the transaction undid it.
    expect(state.products.get('a')).toEqual(legacyOnly());
  });
});

describe('product update response', () => {
  it('asks the database for no legacy English column, on the product and on its variants', async () => {
    await put('a', { name: 'Кефир', localizedImages: { ru: 'https://utfs.io/f/x-ru' } });

    // Every query that returns the full row (the update and the final read) omits the column.
    const returning = state.queries.filter(
      ({ op, args }) => op === 'update' || (op === 'findUnique' && !('select' in args))
    );
    expect(returning.map(({ op }) => op)).toEqual(['update', 'findUnique']);
    for (const { args } of returning) {
      expect(args).toMatchObject({ omit: { imageUrlEn: true } });
    }
    expect(returning[1]!.args).toMatchObject({
      include: { variants: { omit: { imageUrlEn: true } } },
    });
  });
});

describe('product deletion', () => {
  it('does not delete files when a product is deleted', async () => {
    const response = await route.DELETE(
      new Request('http://localhost:3000/api/products/a', { method: 'DELETE' }),
      { params: Promise.resolve({ productId: 'a' }) }
    );

    expect(response.status).toBe(200);
    expect(state.deleted).toEqual([]);
  });
});
