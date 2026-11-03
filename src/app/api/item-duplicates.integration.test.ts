// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '@/lib/prisma-adapter';

// Opt-in: DATABASE_URL is never used implicitly by the test. Fixtures are private,
// randomly named rows, cleaned up without truncating the restored local database.
const url = process.env.INTEGRATION_DATABASE_URL;
const holder = vi.hoisted(() => ({ db: null as unknown as PrismaClient, userId: '' }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_target, key) => Reflect.get(holder.db, key) }),
}));
vi.mock('@/lib/auth-guards', () => ({
  requireUser: async () => ({ session: { user: { id: holder.userId, role: 'USER' } } }),
}));
const { POST } = await import('@/app/api/lists/[listId]/items/route');

describe.skipIf(!url)('duplicate items on local PostgreSQL', () => {
  let db: PrismaClient;
  let categoryId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
      throw new Error('Duplicate-item fixtures require loopback PostgreSQL, never production');
    }
    db = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
    holder.db = db;
    const suffix = randomUUID();
    const user = await db.user.create({ data: { email: `duplicates-${suffix}@example.test` } });
    holder.userId = user.id;
    const category = await db.category.create({
      data: {
        name: `duplicates-${suffix}`,
        nameEn: 'Duplicate item test',
        emoji: '🧪',
        order: 10_000_000 + Math.floor(Math.random() * 1_000_000_000),
      },
    });
    categoryId = category.id;
    const product = await db.product.create({
      data: {
        name: 'Test apple',
        nameEn: 'Test apple',
        emoji: '🍎',
        categoryId,
        isGlobal: false,
        createdById: user.id,
        variants: { create: { name: 'Test Honeycrisp', nameEn: 'Test Honeycrisp', emoji: '🍎' } },
      },
      include: { variants: true },
    });
    productId = product.id;
    variantId = product.variants[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      if (holder.userId) await db.user.deleteMany({ where: { id: holder.userId } });
      if (categoryId) await db.category.deleteMany({ where: { id: categoryId } });
    } finally {
      await db.$disconnect();
    }
  });

  const add = (listId: string, variants: (string | null)[]) =>
    POST(
      new Request('http://localhost/api/lists/test/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: variants.map((id) => ({ productId, variantId: id })) }),
      }),
      { params: Promise.resolve({ listId }) }
    );
  const list = () =>
    db.list.create({ data: { userId: holder.userId, name: 'Duplicate regression' } });

  it('accepts the same non-null variant in successive POST requests', async () => {
    const { id } = await list();
    expect((await add(id, [variantId])).status).toBe(200);
    const repeated = await add(id, [variantId]);
    expect(repeated.status, await repeated.text()).toBe(200);
    const items = await db.item.findMany({ where: { listId: id } });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(items.every((item) => item.variantId === variantId && !item.isPurchased)).toBe(true);
  });

  it('accepts repeated variants in one atomic batch', async () => {
    const { id } = await list();
    const response = await add(id, [variantId, variantId]);
    expect(response.status, await response.text()).toBe(200);
    expect(await db.item.count({ where: { listId: id, variantId } })).toBe(2);
  });

  it('continues accepting duplicate products without a variant', async () => {
    const { id } = await list();
    expect((await add(id, [null, null])).status).toBe(200);
    expect(await db.item.count({ where: { listId: id, variantId: null } })).toBe(2);
  });
});
