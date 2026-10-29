// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// Runs the list operations against a real PostgreSQL to check what the in-memory fakes cannot:
// the row lock, foreign-key lock interaction and transaction rollback. Opt-in, because CI has no
// database service:
//
//   INTEGRATION_DATABASE_URL=postgresql://... npx prisma migrate deploy   (with DATABASE_URL set)
//   INTEGRATION_DATABASE_URL=postgresql://... npx vitest run src/app/api/list-operations
//
// Point it at a disposable database only. Each run creates its own user, category and products
// with a random suffix and deletes exactly those rows afterwards.

const url = process.env.INTEGRATION_DATABASE_URL;

type Hook = () => Promise<void>;
const hooks = vi.hoisted(() => ({
  afterSnapshotRead: undefined as Hook | undefined,
  afterProductLookup: undefined as Hook | undefined,
  userId: '',
}));

vi.mock('@/lib/auth-guards', () => ({
  requireUser: async () => ({ session: { user: { id: hooks.userId, role: 'USER' } } }),
}));

vi.mock('@/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { createPrismaPgAdapter } = await import('@/lib/prisma-adapter');
  const base = new PrismaClient({
    adapter: createPrismaPgAdapter(process.env.INTEGRATION_DATABASE_URL),
  });
  // Lets a test run a concurrent write at an exact point of a route, on a real connection.
  const prisma = base.$extends({
    query: {
      item: {
        async findMany({ args, query }) {
          const result = await query(args);
          await hooks.afterSnapshotRead?.();
          return result;
        },
      },
      list: {
        async findUnique({ args, query }) {
          const result = await query(args);
          if (args.include && 'items' in args.include) await hooks.afterSnapshotRead?.();
          return result;
        },
      },
      product: {
        async findMany({ args, query }) {
          const result = await query(args);
          await hooks.afterProductLookup?.();
          return result;
        },
      },
    },
  });
  return { prisma };
});

describe.skipIf(!url)('list operations on PostgreSQL', () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  let other: PrismaClient;
  let observer: PrismaClient;
  let routes: {
    addItems: typeof import('@/app/api/lists/[listId]/items/route');
    history: typeof import('@/app/api/history/route');
    restore: typeof import('@/app/api/history/[historyId]/restore/route');
  };
  let categoryId: string;
  let listId: string;
  const productIds: string[] = [];

  const post = (body: unknown) =>
    new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const complete = () => routes.history.POST(post({ listId }));

  // Resolves once some backend of this database is waiting for a lock.
  async function lockWaitObserved() {
    for (;;) {
      const rows = await observer.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*) AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (Number(rows[0].waiting) > 0) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    const { createPrismaPgAdapter } = await import('@/lib/prisma-adapter');
    other = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
    observer = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
    routes = {
      addItems: await import('@/app/api/lists/[listId]/items/route'),
      history: await import('@/app/api/history/route'),
      restore: await import('@/app/api/history/[historyId]/restore/route'),
    };

    const user = await other.user.create({ data: { email: `it-${suffix}@example.test` } });
    hooks.userId = user.id;
    const category = await other.category.create({
      data: {
        name: `it-${suffix}`,
        nameEn: `it-${suffix}`,
        emoji: '🧪',
        order: 1_000_000 + Math.floor(Math.random() * 1_000_000),
      },
    });
    categoryId = category.id;
    for (const name of ['milk', 'bread', 'eggs']) {
      const created = await other.product.create({
        data: { name: `${name}-${suffix}`, nameEn: name, emoji: '🛒', categoryId },
      });
      productIds.push(created.id);
    }
  });

  afterAll(async () => {
    if (!other) return;
    await other.user.deleteMany({ where: { id: hooks.userId } });
    await other.category.deleteMany({ where: { id: categoryId } });
    await Promise.all([other.$disconnect(), observer.$disconnect()]);
  });

  beforeEach(async () => {
    hooks.afterSnapshotRead = undefined;
    hooks.afterProductLookup = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const list = await other.list.create({ data: { userId: hooks.userId, name: 'Покупки' } });
    listId = list.id;
  });

  it('adds a valid batch in one insert and an invalid batch not at all', async () => {
    const [milk, bread] = productIds;
    const bad = await routes.addItems.POST(
      post({ items: [{ productId: milk }, { productId: bread }, { productId: 'missing' }] }),
      { params: Promise.resolve({ listId }) }
    );
    expect(bad.status).toBe(404);
    expect(await other.item.count({ where: { listId } })).toBe(0);

    const good = await routes.addItems.POST(
      post({ items: [{ productId: milk, note: '2 л' }, { productId: bread }] }),
      { params: Promise.resolve({ listId }) }
    );
    expect(good.status).toBe(200);
    const body = await good.json();
    expect(body.createdItems.map((item: { productId: string }) => item.productId)).toEqual([
      milk,
      bread,
    ]);
    expect(body.createdItems[0].product.category.id).toBe(categoryId);
    expect(await other.item.count({ where: { listId } })).toBe(2);
  });

  it('does not lose an item added while the list is being completed', async () => {
    const [milk, bread, eggs] = productIds;
    await other.item.createMany({
      data: [
        { listId, productId: milk },
        { listId, productId: bread },
      ],
    });

    // Right after the snapshot read, another request adds an item on its own connection. It
    // either commits at once or waits for the complete transaction to release the list lock.
    let concurrentAdd: Promise<unknown> | undefined;
    hooks.afterSnapshotRead = async () => {
      if (concurrentAdd) return;
      concurrentAdd = other.item.create({ data: { listId, productId: eggs } });
      await Promise.race([concurrentAdd, lockWaitObserved()]);
    };

    const response = await complete();
    await concurrentAdd;

    expect(response.status).toBe(200);
    const history = await response.json();
    const inSnapshot = history.items.some((item: { productId: string }) => item.productId === eggs);
    const inList = (await other.item.count({ where: { listId, productId: eggs } })) === 1;
    expect(inSnapshot || inList).toBe(true);
    expect(inSnapshot && inList).toBe(false);
  });

  it('creates one snapshot when the same list is completed twice at once', async () => {
    await other.item.create({ data: { listId, productId: productIds[0] } });

    const statuses = (await Promise.all([complete(), complete()])).map((r) => r.status).sort();

    expect(statuses).toEqual([200, 400]);
    expect(await other.listHistory.count({ where: { listId } })).toBe(1);
  });

  it('leaves no list behind when a restored product disappears before the insert', async () => {
    const [milk] = productIds;
    const doomed = await other.product.create({
      data: { name: `doomed-${suffix}`, nameEn: 'doomed', emoji: '🛒', categoryId },
    });
    const history = await other.listHistory.create({
      data: {
        userId: hooks.userId,
        listName: 'Покупки',
        items: {
          create: [milk, doomed.id].map((productId) => ({
            productId,
            productName: productId,
            productEmoji: '🛒',
            categoryName: 'it',
            addedAt: new Date(),
          })),
        },
      },
    });
    hooks.afterProductLookup = async () => {
      hooks.afterProductLookup = undefined;
      await other.product.delete({ where: { id: doomed.id } });
    };
    const listsBefore = await other.list.count({ where: { userId: hooks.userId } });

    const response = await routes.restore.POST(post({}), {
      params: Promise.resolve({ historyId: history.id }),
    });

    expect(response.status).toBe(500);
    expect(await other.list.count({ where: { userId: hooks.userId } })).toBe(listsBefore);
  });
});
