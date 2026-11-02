// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { createPrismaPgAdapter } from '../prisma-adapter';
import { applyCatalogCleanup, type CatalogCleanupPlan } from './catalog-cleanup';

// Run only through npm run test:catalog-postgres: it creates and removes its own Docker DB.
const url = process.env.INTEGRATION_DATABASE_URL;
const plan: CatalogCleanupPlan = {
  merges: [
    { keep: { name: 'Яблоко', nameEn: 'Apple' }, drop: { name: 'Яблоки', nameEn: 'Apples' } },
  ],
  variants: [
    {
      parent: { name: 'Яблоко', nameEn: 'Apple' },
      child: { name: 'Ханикрисп', nameEn: 'Honey crisp' },
      name: 'Ханикрисп',
      nameEn: 'Honeycrisp',
    },
  ],
  moves: [],
  renames: [],
};
const noop = () => {};
function barrier<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );

describe.skipIf(!url)('catalog cleanup on disposable PostgreSQL', () => {
  let db: PrismaClient;
  let writer: PrismaClient;
  let observer: PrismaClient;
  const options = { timeout: 20_000, maxWait: 10_000, isolationLevel: 'ReadCommitted' as const };

  beforeAll(() => {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/catalog_cleanup_test') {
      throw new Error('This destructive fixture requires the Docker test runner database');
    }
    db = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
    writer = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
    observer = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
  });
  afterAll(async () => {
    await Promise.all([db?.$disconnect(), writer?.$disconnect(), observer?.$disconnect()]);
  });
  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE users, categories RESTART IDENTITY CASCADE`;
    await db.user.create({ data: { id: 'user', email: 'cleanup@example.test' } });
    await db.category.create({
      data: { id: 'fruit', name: 'Фрукты', nameEn: 'Fruit', emoji: '🍎', order: 1 },
    });
    await db.list.create({ data: { id: 'list', userId: 'user', name: 'Shopping' } });
    await db.listHistory.create({ data: { id: 'history', userId: 'user', listName: 'Shopping' } });
    for (const [id, name, nameEn] of [
      ['apple', 'Яблоко', 'Apple'],
      ['apples', 'Яблоки', 'Apples'],
      ['child', 'Ханикрисп', 'Honey crisp'],
    ]) {
      await db.product.create({
        data: {
          id,
          name,
          nameEn,
          categoryId: 'fruit',
          emoji: '🍎',
          isCustom: id === 'child',
          imageUrl: id === 'child' ? '/child.webp' : null,
          imageUrlEn: id === 'child' ? '/child-en.webp' : null,
        },
      });
      await db.item.create({ data: { id: `item-${id}`, listId: 'list', productId: id } });
      await db.listHistoryItem.create({ data: historyData(id, `history-${id}`) });
      await db.favorite.create({ data: { userId: 'user', productId: id, usageCount: 2 } });
    }
  });

  function historyData(productId: string, id: string, variantId?: string) {
    return {
      id,
      historyId: 'history',
      productId,
      variantId,
      productName: 'Snapshot',
      productEmoji: '🍎',
      categoryName: 'Fruit',
      addedAt: new Date('2026-01-01T00:00:00Z'),
    };
  }
  async function pid(tx: Prisma.TransactionClient) {
    return (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
  }
  async function waitForBlock(blockedPid: number, blockerPid: number) {
    const deadline = Date.now() + 5_000;
    do {
      const [row] = await observer.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${blockedPid}::int)) AS blocked`;
      if (row.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error(`Expected backend ${blockedPid} to wait for ${blockerPid}`);
  }
  const cleanup = (selectedPlan = plan) =>
    db.$transaction((tx) => applyCatalogCleanup(tx, selectedPlan, noop), options);
  async function snapshot() {
    return JSON.stringify(
      await Promise.all([
        db.product.findMany({ orderBy: { id: 'asc' } }),
        db.productVariant.findMany({ orderBy: { id: 'asc' } }),
        db.item.findMany({ orderBy: { id: 'asc' } }),
        db.listHistoryItem.findMany({ orderBy: { id: 'asc' } }),
        db.favorite.findMany({ orderBy: { id: 'asc' } }),
        db.variantFavorite.findMany({ orderBy: { id: 'asc' } }),
      ])
    );
  }
  function variantData(overrides: Partial<Prisma.ProductVariantUncheckedCreateInput> = {}) {
    return {
      id: 'existing',
      productId: 'apple',
      name: 'Ханикрисп',
      nameEn: 'Honeycrisp',
      emoji: '🍏',
      ...overrides,
    };
  }

  it.each(['different EN', 'different RU', 'multiple', 'picture conflict'])(
    'rolls back the entire transaction including earlier merges on %s',
    async (conflict) => {
      await db.productVariant.create({
        data: variantData(
          conflict === 'different EN'
            ? { nameEn: 'Other' }
            : conflict === 'different RU'
              ? { name: 'Другое' }
              : conflict === 'picture conflict'
                ? { imageUrlEn: '/other.webp' }
                : {}
        ),
      });
      if (conflict === 'multiple')
        await db.productVariant.create({ data: variantData({ id: 'second' }) });
      const before = await snapshot();
      await expect(cleanup()).rejects.toThrow(/variant/i);
      expect(await snapshot()).toBe(before);
    }
  );

  it('reuses an exact variant, copies both pictures, preserves references and is idempotent', async () => {
    await db.productVariant.create({ data: variantData() });
    await cleanup();
    expect(await db.productVariant.findUnique({ where: { id: 'existing' } })).toMatchObject({
      imageUrl: '/child.webp',
      imageUrlEn: '/child-en.webp',
    });
    expect(await db.item.findUnique({ where: { id: 'item-child' } })).toMatchObject({
      productId: 'apple',
      variantId: 'existing',
    });
    expect(await db.listHistoryItem.findUnique({ where: { id: 'history-child' } })).toMatchObject({
      productId: 'apple',
      variantId: 'existing',
      productName: 'Snapshot',
    });
    expect(
      await db.variantFavorite.count({ where: { userId: 'user', variantId: 'existing' } })
    ).toBe(1);
    const before = await snapshot();
    await cleanup();
    expect(await snapshot()).toBe(before);
  });

  it.each(['merge', 'variant'])(
    'waits for an in-flight writer BEFORE reading (%s), then transfers its committed item/history',
    async (mode) => {
      const source = mode === 'merge' ? 'apples' : 'child';
      const held = barrier<number>();
      const release = barrier();
      const writing = outcome(
        writer.$transaction(async (tx) => {
          await tx.item.create({ data: { id: 'early-item', listId: 'list', productId: source } });
          await tx.listHistoryItem.create({ data: historyData(source, 'early-history') });
          held.resolve(await pid(tx));
          await release.promise;
        }, options)
      );
      const writerPid = await held.promise;
      const started = barrier<number>();
      const cleaning = outcome(
        db.$transaction(async (tx) => {
          started.resolve(await pid(tx));
          await applyCatalogCleanup(tx, plan, noop);
        }, options)
      );
      try {
        await waitForBlock(await started.promise, writerPid);
      } finally {
        release.resolve();
        await Promise.all([writing, cleaning]);
      }
      expect((await writing).ok).toBe(true);
      expect((await cleaning).ok).toBe(true);
      const item = await db.item.findUniqueOrThrow({ where: { id: 'early-item' } });
      const history = await db.listHistoryItem.findUniqueOrThrow({
        where: { id: 'early-history' },
      });
      expect(item.productId).toBe('apple');
      expect(history.productId).toBe('apple');
      expect(item.variantId).toBe(history.variantId);
      if (mode === 'variant') expect(item.variantId).not.toBeNull();
    }
  );

  it.each(['merge', 'variant'])(
    'blocks ALL writers after transfer until commit (%s); stale references fail, not cascade or dangle',
    async (mode) => {
      const source = mode === 'merge' ? 'apples' : 'child';
      await db.productVariant.create({
        data: variantData({ id: 'retained', productId: 'apples', name: 'Other', nameEn: 'Other' }),
      });
      const paused = barrier<number>();
      const release = barrier();
      const cleaning = outcome(
        db.$transaction(async (tx) => {
          const cleanupPid = await pid(tx);
          const hooked = new Proxy(tx, {
            get(target, property) {
              if (property !== 'product') return Reflect.get(target, property);
              return new Proxy(target.product, {
                get(delegate, method) {
                  if (method !== 'delete') return Reflect.get(delegate, method);
                  return async (args: Prisma.ProductDeleteArgs) => {
                    if (args.where.id === source) {
                      paused.resolve(cleanupPid);
                      await release.promise;
                    }
                    return delegate.delete(args);
                  };
                },
              });
            },
          });
          await applyCatalogCleanup(hooked, plan, noop);
        }, options)
      );
      const cleanupPid = await paused.promise;
      const operations = [
        {
          name: 'item',
          write: (tx: Prisma.TransactionClient) =>
            tx.item.create({ data: { id: 'late-item', listId: 'list', productId: source } }),
        },
        {
          name: 'favorite',
          write: (tx: Prisma.TransactionClient) =>
            tx.favorite.create({ data: { userId: 'user', productId: source } }),
        },
        {
          name: 'variant',
          write: (tx: Prisma.TransactionClient) =>
            tx.productVariant.create({
              data: variantData({ id: 'late-variant', productId: source }),
            }),
        },
        {
          name: 'history',
          write: (tx: Prisma.TransactionClient) =>
            tx.listHistoryItem.create({ data: historyData(source, 'late-history') }),
        },
        // The variant survives a merge, so this write must succeed AFTER the lock releases.
        {
          name: 'variant favorite',
          write: (tx: Prisma.TransactionClient) =>
            tx.variantFavorite.create({ data: { userId: 'user', variantId: 'retained' } }),
        },
      ];
      const pending = operations.map(({ name, write }) => {
        const started = barrier<number>();
        const result = outcome(
          writer.$transaction(async (tx) => {
            started.resolve(await pid(tx));
            await write(tx);
          }, options)
        );
        return { name, started, result };
      });
      try {
        // Inspect exact backend blockers, not a sleep or a hoped-for race.
        for (const pendingWrite of pending) {
          const result = await Promise.race([
            pendingWrite.result.then(() => 'settled'),
            pendingWrite.started.promise
              .then((writerPid) => waitForBlock(writerPid, cleanupPid))
              .then(() => 'blocked'),
          ]);
          expect(result, pendingWrite.name).toBe('blocked');
        }
      } finally {
        release.resolve();
        await Promise.all([cleaning, ...pending.map((pendingWrite) => pendingWrite.result)]);
      }
      expect((await cleaning).ok).toBe(true);
      for (const pendingWrite of pending) {
        const result = await pendingWrite.result;
        if (pendingWrite.name === 'variant favorite') expect(result.ok).toBe(true);
        else {
          expect(result.ok, pendingWrite.name).toBe(false);
          if (!result.ok) expect(result.error).toMatchObject({ code: 'P2003' });
        }
      }
      expect(await db.item.findUnique({ where: { id: 'late-item' } })).toBeNull();
      expect(await db.listHistoryItem.findUnique({ where: { id: 'late-history' } })).toBeNull();
      expect(await db.variantFavorite.count({ where: { variantId: 'retained' } })).toBe(1);
      const [dangling] = await observer.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM list_history_items h
        LEFT JOIN products p ON p.id = h."productId"
        LEFT JOIN product_variants v ON v.id = h."variantId"
        WHERE (h."productId" IS NOT NULL AND p.id IS NULL)
           OR (h."variantId" IS NOT NULL AND v.id IS NULL)`;
      expect(Number(dangling.count)).toBe(0);
    }
  );

  it('migrates legacy dangling IDs without losing snapshot fields or valid references', async () => {
    const sql = readFileSync(
      new URL(
        '../../../prisma/migrations/20261102210000_protect_history_catalog_references/migration.sql',
        import.meta.url
      ),
      'utf8'
    );
    await db.$transaction(async (tx) => {
      // Reproduce the pre-migration schema and data inside one isolated transaction.
      await tx.$executeRaw`ALTER TABLE list_history_items DROP CONSTRAINT "list_history_items_productId_fkey"`;
      await tx.$executeRaw`ALTER TABLE list_history_items DROP CONSTRAINT "list_history_items_variantId_fkey"`;
      await tx.$executeRaw`DROP INDEX "list_history_items_productId_idx"`;
      await tx.$executeRaw`DROP INDEX "list_history_items_variantId_idx"`;
      await tx.listHistoryItem.create({
        data: historyData('deleted-product', 'legacy', 'deleted-variant'),
      });
      const before = await tx.listHistoryItem.findUniqueOrThrow({ where: { id: 'legacy' } });
      // The migration has its own BEGIN/COMMIT in deploy; this test already has a transaction.
      const statements = sql
        .replace(/^--.*$/gm, '')
        .split(';')
        .map((statement) => statement.trim());
      for (const statement of statements) {
        if (statement && statement !== 'BEGIN' && statement !== 'COMMIT') {
          await tx.$executeRawUnsafe(statement);
        }
      }
      expect(await tx.listHistoryItem.findUniqueOrThrow({ where: { id: 'legacy' } })).toEqual({
        ...before,
        productId: null,
        variantId: null,
      });
      expect(
        await tx.listHistoryItem.findUniqueOrThrow({ where: { id: 'history-apple' } })
      ).toMatchObject({
        productId: 'apple',
        productName: 'Snapshot',
      });
    }, options);
  });

  it('refuses to run against a database without history FKs, with no partial changes', async () => {
    const before = await snapshot();
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE list_history_items DROP CONSTRAINT "list_history_items_productId_fkey"`;
        await applyCatalogCleanup(tx, plan, noop);
      }, options)
    ).rejects.toThrow(/history.*migration/i);
    expect(await snapshot()).toBe(before);
    // The failed transaction also restores the removed constraint.
    await expect(
      db.listHistoryItem.create({ data: historyData('missing', 'stale') })
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('rolls back dry runs completely and releases writer locks', async () => {
    const before = await snapshot();
    const paused = barrier<number>();
    const release = barrier();
    const cleaning = outcome(
      db.$transaction(async (tx) => {
        await applyCatalogCleanup(tx, plan, noop);
        paused.resolve(await pid(tx));
        await release.promise;
        throw new Error('Dry run rollback');
      }, options)
    );
    const cleanupPid = await paused.promise;
    const started = barrier<number>();
    const writing = outcome(
      writer.$transaction(async (tx) => {
        started.resolve(await pid(tx));
        await tx.listHistoryItem.create({ data: historyData('child', 'after-rollback') });
      }, options)
    );
    try {
      await waitForBlock(await started.promise, cleanupPid);
      // Readers see only committed data, never the partially cleaned catalogue.
      expect(await snapshot()).toBe(before);
    } finally {
      release.resolve();
      await Promise.all([cleaning, writing]);
    }
    expect((await cleaning).ok).toBe(false);
    expect((await writing).ok).toBe(true);
    expect(
      await db.listHistoryItem.findUniqueOrThrow({ where: { id: 'after-rollback' } })
    ).toMatchObject({ productId: 'child' });
    await db.listHistoryItem.delete({ where: { id: 'after-rollback' } });
    expect(await snapshot()).toBe(before);
  });

  it('retains history snapshots on ordinary deletion but rejects future stale product/variant IDs', async () => {
    await db.productVariant.create({ data: variantData() });
    await db.listHistoryItem.update({
      where: { id: 'history-apple' },
      data: { variantId: 'existing' },
    });
    await db.product.delete({ where: { id: 'apple' } });
    expect(
      await db.listHistoryItem.findUniqueOrThrow({ where: { id: 'history-apple' } })
    ).toMatchObject({
      productId: null,
      variantId: null,
      productName: 'Snapshot',
    });
    await expect(
      db.listHistoryItem.create({ data: historyData('apple', 'stale-product') })
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      db.listHistoryItem.create({ data: historyData('child', 'stale-variant', 'existing') })
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
