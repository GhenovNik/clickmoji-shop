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
};

const state = vi.hoisted(() => ({
  products: new Map<string, Pictures>(),
  deleted: [] as string[],
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
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        product: {
          update: async ({ where, data }: { where: { id: string }; data: Partial<Pictures> }) => {
            const next = { ...state.products.get(where.id)!, ...data };
            state.products.set(where.id, next);
            return next;
          },
          findUnique: async ({ where }: { where: { id: string } }) => state.products.get(where.id),
        },
      };
      return work(tx);
    },
  },
}));

const route = await import('@/app/api/products/[productId]/route');

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

    await put('a', { imageUrl: null, localizedImages: {} });

    expect(state.deleted).toEqual([]);
  });

  it('stores the picture languages and mirrors English into the legacy column', async () => {
    await put('b', {
      imageUrl: X,
      localizedImages: { en: 'https://utfs.io/f/x-en', ru: 'https://utfs.io/f/x-ru' },
    });

    expect(state.products.get('b')).toMatchObject({
      imageUrlEn: 'https://utfs.io/f/x-en',
      localizedImages: { en: 'https://utfs.io/f/x-en' },
    });
  });

  it('stores SQL NULL for an empty dictionary', async () => {
    state.products.set('a', {
      imageUrl: X,
      imageUrlEn: 'https://utfs.io/f/x-en',
      localizedImages: { en: 'https://utfs.io/f/x-en' },
    });

    await put('a', { imageUrl: X, localizedImages: {} });

    expect(state.products.get('a')).toMatchObject({
      imageUrlEn: null,
      localizedImages: Prisma.DbNull,
    });
  });

  it('does not delete files when a product is deleted', async () => {
    const response = await route.DELETE(
      new Request('http://localhost:3000/api/products/a', { method: 'DELETE' }),
      { params: Promise.resolve({ productId: 'a' }) }
    );

    expect(response.status).toBe(200);
    expect(state.deleted).toEqual([]);
  });
});
