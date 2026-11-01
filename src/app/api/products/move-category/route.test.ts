// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// The answer names the target category in the interface language; the counts stay as they are.

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => ({ session: { user: { id: 'admin-1', role: 'ADMIN' } } }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    category: {
      findUnique: async () => ({ id: 'drinks', name: 'Напитки', nameEn: 'Drinks' }),
    },
    product: { updateMany: async () => ({ count: 2 }) },
  },
}));

const { POST } = await import('./route');

describe('POST /api/products/move-category', () => {
  it.each([
    ['ru', 'Напитки'],
    ['en', 'Drinks'],
  ])('names the target category in the request language (%s)', async (locale, name) => {
    const response = await POST(
      new Request('http://localhost:3000/api/products/move-category', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `NEXT_LOCALE=${locale}` },
        body: JSON.stringify({ productIds: ['a', 'b'], newCategoryId: 'drinks' }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, movedCount: 2, targetCategory: name });
  });
});
