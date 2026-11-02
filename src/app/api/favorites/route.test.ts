// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A starred variant is a favorite of its own: it is stored apart from product favorites, comes
// back in the same list with its parent product, and is starred and unstarred by its own id.

const db = vi.hoisted(() => ({
  favorite: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  variantFavorite: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  productVariant: { findFirst: vi.fn() },
  product: { findFirst: vi.fn() },
}));

vi.mock('@/lib/auth-guards', () => ({
  requireUser: async () => ({ session: { user: { id: 'user-1', role: 'USER' } } }),
}));
vi.mock('@/lib/prisma', () => ({ prisma: db }));

const { GET, POST, DELETE } = await import('./route');

const apple = { id: 'apple', name: 'Яблоко', nameEn: 'Apple', emoji: '🍎', category: {} };
const honeycrisp = {
  id: 'honeycrisp',
  name: 'Яблоко Ханикрисп',
  nameEn: 'Honeycrisp apple',
  emoji: '🍎',
  imageUrl: '/honeycrisp.webp',
  imageUrlEn: null,
};

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/favorites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/favorites', () => {
  it('lists product favorites and starred variants together, most used first', async () => {
    db.favorite.findMany.mockResolvedValue([
      { id: 'f-1', userId: 'user-1', productId: 'apple', usageCount: 2, product: apple },
    ]);
    db.variantFavorite.findMany.mockResolvedValue([
      {
        id: 'vf-1',
        userId: 'user-1',
        variantId: 'honeycrisp',
        usageCount: 5,
        variant: { ...honeycrisp, product: apple },
      },
    ]);

    const body = await (await GET()).json();

    expect(body).toEqual([
      {
        id: 'vf-1',
        userId: 'user-1',
        usageCount: 5,
        productId: 'apple',
        product: apple,
        variant: honeycrisp,
      },
      {
        id: 'f-1',
        userId: 'user-1',
        productId: 'apple',
        usageCount: 2,
        product: apple,
        variant: null,
      },
    ]);
    // Only the user's own stars of variants whose product the user can see.
    expect(db.variantFavorite.findMany.mock.calls[0][0].where).toMatchObject({
      userId: 'user-1',
      variant: { product: expect.any(Object) },
    });
  });
});

describe('POST /api/favorites', () => {
  it('stars a visible variant on its own, without touching product favorites', async () => {
    db.productVariant.findFirst.mockResolvedValue({ id: 'honeycrisp' });
    db.variantFavorite.upsert.mockResolvedValue({ id: 'vf-1', usageCount: 1, variant: honeycrisp });

    const response = await post({ variantId: 'honeycrisp' });

    expect(response.status).toBe(200);
    expect(db.variantFavorite.upsert.mock.calls[0][0]).toMatchObject({
      where: { userId_variantId: { userId: 'user-1', variantId: 'honeycrisp' } },
      create: { userId: 'user-1', variantId: 'honeycrisp', usageCount: 1 },
    });
    expect(db.favorite.upsert).not.toHaveBeenCalled();
  });

  it('refuses a variant of a product the user cannot see', async () => {
    db.productVariant.findFirst.mockResolvedValue(null);

    const response = await post({ variantId: 'foreign' });

    expect(response.status).toBe(404);
    expect(db.variantFavorite.upsert).not.toHaveBeenCalled();
  });

  it('marks a product favorite with variant: null', async () => {
    db.product.findFirst.mockResolvedValue({ id: 'apple' });
    db.favorite.upsert.mockResolvedValue({ id: 'f-1', productId: 'apple', product: apple });

    const body = await (await post({ productId: 'apple' })).json();

    expect(body.variant).toBeNull();
  });
});

describe('DELETE /api/favorites', () => {
  it("unstars a variant by its id, only among the user's own stars", async () => {
    db.variantFavorite.deleteMany.mockResolvedValue({ count: 1 });

    const response = await DELETE(
      new Request('http://localhost/api/favorites?variantId=honeycrisp', { method: 'DELETE' })
    );

    expect(response.status).toBe(200);
    expect(db.variantFavorite.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', variantId: 'honeycrisp' },
    });
    expect(db.favorite.delete).not.toHaveBeenCalled();
  });
});
