// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Replaced pictures leave UploadThing only after the update commits, and only when nothing,
// including the product's other picture field, still shows them.

const state = vi.hoisted(() => ({
  product: { imageUrl: null as string | null, imageUrlEn: null as string | null },
  failTransaction: false,
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

// The in-use check reads the committed product: a file still in either field is in use.
vi.mock('@/lib/services/emoji-library', () => ({
  isStoredImageInUse: async (url: string) =>
    state.product.imageUrl === url || state.product.imageUrlEn === url,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    product: { findUnique: async () => ({ ...state.product }) },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const draft = { ...state.product };
      const tx = {
        product: {
          update: async ({ data }: { data: Partial<typeof draft> }) => Object.assign(draft, data),
          findUnique: async () => draft,
        },
      };
      const result = await work(tx);
      if (state.failTransaction) throw new Error('transaction rolled back');
      state.product = draft;
      return result;
    },
  },
}));

const { PUT } = await import('@/app/api/products/[productId]/route');

function put(body: Record<string, unknown>) {
  return PUT(
    new Request('http://localhost:3000/api/products/p1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ productId: 'p1' }) }
  );
}

beforeEach(() => {
  state.product = { imageUrl: null, imageUrlEn: null };
  state.failTransaction = false;
  state.deleted.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('PUT /api/products/[productId] picture lifecycle', () => {
  it('keeps a file the other picture field of the same product still shows', async () => {
    state.product = {
      imageUrl: 'https://utfs.io/f/shared',
      imageUrlEn: 'https://utfs.io/f/shared',
    };

    const response = await put({ imageUrlEn: 'https://utfs.io/f/new' });

    expect(response.status).toBe(200);
    expect(state.deleted).toEqual([]);
  });

  it('deletes nothing when the update fails', async () => {
    state.product = { imageUrl: 'https://utfs.io/f/old', imageUrlEn: null };
    state.failTransaction = true;

    const response = await put({ imageUrl: 'https://utfs.io/f/new' });

    expect(response.status).toBe(500);
    expect(state.deleted).toEqual([]);
    expect(state.product.imageUrl).toBe('https://utfs.io/f/old');
  });

  it('deletes a replaced file once nothing shows it', async () => {
    state.product = { imageUrl: 'https://utfs.io/f/old', imageUrlEn: 'https://utfs.io/f/old-en' };

    await put({ imageUrl: 'https://utfs.io/f/new', imageUrlEn: null });

    expect(state.deleted.sort()).toEqual(['old', 'old-en']);
  });
});
