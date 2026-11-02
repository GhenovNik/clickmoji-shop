import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { applyCatalogCleanup, type CatalogCleanupPlan } from './catalog-cleanup';

// The cleanup deletes products, so nothing that points at them may be lost: list items, history
// items and favorites move to the product that stays, or to the new variant. It runs on a small
// in-memory catalogue that answers the Prisma calls the cleanup makes.

type Row = Record<string, unknown> & { id: string };

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) =>
    key === 'OR'
      ? (value as Record<string, unknown>[]).some((clause) => matches(row, clause))
      : row[key] === value
  );
}

function table(rows: Row[]) {
  let next = 0;
  return {
    rows,
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      rows.filter((row) => matches(row, where)),
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      rows.find((row) => matches(row, where)) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `new-${++next}`, ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      rows.splice(
        rows.findIndex((row) => row.id === where.id),
        1
      );
    },
  };
}

function catalogue() {
  const product = table([
    {
      id: 'apple',
      name: 'Яблоко',
      nameEn: 'Apple',
      isGlobal: true,
      isCustom: false,
      emoji: '🍎',
      imageUrl: null,
      categoryId: 'fruit',
    },
    {
      id: 'apples',
      name: 'Яблоки',
      nameEn: 'Apples',
      isGlobal: true,
      isCustom: true,
      emoji: '🍎',
      imageUrl: '/apples.webp',
      imageUrlEn: null,
      categoryId: 'fruit',
    },
    {
      id: 'honeycrisp',
      name: 'Яблоко Ханикрисп',
      nameEn: 'Honey crisp apple',
      isGlobal: true,
      isCustom: true,
      emoji: '🍏',
      imageUrl: '/hc.webp',
      imageUrlEn: '/hc-en.webp',
      categoryId: 'fruit',
    },
    {
      id: 'lobster',
      name: 'Лобстер',
      nameEn: 'Lobster',
      isGlobal: true,
      isCustom: false,
      emoji: '🦞',
      imageUrl: null,
      categoryId: 'meat',
    },
  ]);
  const productVariant = table([]);
  const db = {
    $executeRaw: vi.fn<(query: TemplateStringsArray) => Promise<number>>(async () => 0),
    $queryRaw: vi.fn(async () => [{ count: BigInt(2) }]),
    product: {
      ...product,
      // The cleanup reads each product with its variants.
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        product.rows
          .filter((row) => matches(row, where))
          .map((row) => ({
            ...row,
            variants: productVariant.rows.filter((variant) => variant.productId === row.id),
          })),
    },
    productVariant,
    category: table([
      { id: 'meat', nameEn: 'Meat' },
      { id: 'fish', nameEn: 'Fish & Seafood' },
    ]),
    item: table([
      { id: 'i-1', productId: 'apples', variantId: null },
      { id: 'i-2', productId: 'honeycrisp', variantId: null },
    ]),
    listHistoryItem: table([{ id: 'h-1', productId: 'honeycrisp', variantId: null }]),
    favorite: {
      ...table([
        { id: 'f-1', userId: 'ann', productId: 'apple', usageCount: 2 },
        { id: 'f-2', userId: 'ann', productId: 'apples', usageCount: 3 },
        { id: 'f-3', userId: 'bob', productId: 'apples', usageCount: 1 },
        { id: 'f-4', userId: 'bob', productId: 'honeycrisp', usageCount: 4 },
      ]),
    },
    variantFavorite: {
      ...table([]),
      upsert: async ({
        create,
      }: {
        create: { userId: string; variantId: string; usageCount: number };
      }) => {
        db.variantFavorite.rows.push({ id: `vf-${create.userId}`, ...create });
      },
    },
  };
  Object.assign(db.favorite, {
    findUnique: async ({
      where: { userId_productId: key },
    }: {
      where: { userId_productId: { userId: string; productId: string } };
    }) => db.favorite.rows.find((row) => matches(row, key)) ?? null,
  });
  return db;
}

const plan: CatalogCleanupPlan = {
  merges: [
    { keep: { name: 'Яблоко', nameEn: 'Apple' }, drop: { name: 'Яблоки', nameEn: 'Apples' } },
  ],
  variants: [
    {
      parent: { name: 'Яблоко', nameEn: 'Apple' },
      child: { name: 'Яблоко Ханикрисп', nameEn: 'Honey crisp apple' },
      name: 'Яблоко Ханикрисп',
      nameEn: 'Honeycrisp apple',
    },
  ],
  moves: [{ product: { name: 'Лобстер', nameEn: 'Lobster' }, categoryEn: 'Fish & Seafood' }],
  renames: [],
};

async function run(db: ReturnType<typeof catalogue>) {
  const log: string[] = [];
  await applyCatalogCleanup(db as unknown as Prisma.TransactionClient, plan, (line) =>
    log.push(line)
  );
  return log;
}

describe('applyCatalogCleanup', () => {
  function existingVariant(overrides: Record<string, unknown> = {}): Row {
    return {
      id: 'existing',
      productId: 'apple',
      name: plan.variants[0].name,
      nameEn: plan.variants[0].nameEn,
      emoji: '🍏',
      imageUrl: null,
      imageUrlEn: null,
      ...overrides,
    };
  }

  it.each([
    [existingVariant({ nameEn: 'Different apple' })],
    [existingVariant({ name: 'Другое яблоко' })],
    [existingVariant(), existingVariant({ id: 'second' })],
    [existingVariant({ imageUrl: '/different.webp' })],
    [existingVariant({ imageUrlEn: '/different-en.webp' })],
  ])('rejects conflicting or ambiguous existing variants: %j', async (...candidates) => {
    const db = catalogue();
    db.productVariant.rows.push(...candidates);
    // This unit test checks fail-closed identity validation before moving the child. Real
    // transaction rollback, including earlier merges, is covered on PostgreSQL.
    const childRows = () =>
      JSON.stringify({
        child: db.product.rows.find((row) => row.id === 'honeycrisp'),
        item: db.item.rows.find((row) => row.id === 'i-2'),
        history: db.listHistoryItem.rows,
        star: db.favorite.rows.find((row) => row.id === 'f-4'),
      });
    const before = childRows();
    await expect(run(db)).rejects.toThrow(/variant/i);
    expect(childRows()).toBe(before);
  });

  it('reuses only an exact identity and explicitly transfers both child pictures', async () => {
    const db = catalogue();
    db.productVariant.rows.push(existingVariant());
    await run(db);
    expect(db.productVariant.rows).toEqual([
      existingVariant({ imageUrl: '/hc.webp', imageUrlEn: '/hc-en.webp' }),
    ]);
    expect(db.item.rows.find((row) => row.id === 'i-2')).toMatchObject({
      productId: 'apple',
      variantId: 'existing',
    });
    expect(db.listHistoryItem.rows[0].variantId).toBe('existing');
    expect(db.variantFavorite.rows[0].variantId).toBe('existing');
  });

  it('locks writers before any catalogue reads', async () => {
    const db = catalogue();
    const read = vi.spyOn(db.product, 'findMany');
    await run(db);
    const statements = db.$executeRaw.mock.calls.map((call) => String(call[0]));
    const lockIndex = statements.findIndex((statement) => /LOCK TABLE/.test(statement));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(statements[lockIndex]).toContain('SHARE ROW EXCLUSIVE MODE');
    expect(db.$executeRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(
      read.mock.invocationCallOrder[0]
    );
  });

  it('refuses cleanup before the history reference migration is deployed', async () => {
    const db = catalogue();
    db.$queryRaw.mockResolvedValue([{ count: BigInt(0) }]);
    const before = JSON.stringify(db);
    await expect(run(db)).rejects.toThrow(/history.*migration/i);
    expect(JSON.stringify(db)).toBe(before);
  });

  it('folds a duplicate into the singular product without losing items or favorites', async () => {
    const db = catalogue();
    await run(db);

    expect(db.product.rows.map((row) => row.id)).not.toContain('apples');
    expect(db.item.rows.find((row) => row.id === 'i-1')).toMatchObject({ productId: 'apple' });
    // Ann starred both: one favorite with both counts. Bob starred only the duplicate: it moves.
    expect(db.favorite.rows.filter((row) => row.userId === 'ann')).toEqual([
      { id: 'f-1', userId: 'ann', productId: 'apple', usageCount: 5 },
    ]);
    expect(db.favorite.rows.find((row) => row.id === 'f-3')).toMatchObject({ productId: 'apple' });
    // The singular product had no picture of its own, so it takes the duplicate's.
    expect(db.product.rows.find((row) => row.id === 'apple')).toMatchObject({
      isCustom: true,
      imageUrl: '/apples.webp',
    });
  });

  it('turns a product into a variant with its picture, items, history and stars', async () => {
    const db = catalogue();
    await run(db);

    const [variant] = db.productVariant.rows;
    expect(variant).toMatchObject({
      productId: 'apple',
      name: 'Яблоко Ханикрисп',
      nameEn: 'Honeycrisp apple',
      emoji: '🍏',
      imageUrl: '/hc.webp',
      imageUrlEn: '/hc-en.webp',
    });
    expect(db.product.rows.map((row) => row.id)).not.toContain('honeycrisp');
    expect(db.item.rows.find((row) => row.id === 'i-2')).toMatchObject({
      productId: 'apple',
      variantId: variant.id,
    });
    expect(db.listHistoryItem.rows[0]).toMatchObject({ productId: 'apple', variantId: variant.id });
    expect(db.variantFavorite.rows).toEqual([
      { id: 'vf-bob', userId: 'bob', variantId: variant.id, usageCount: 4 },
    ]);
  });

  it('moves a misfiled product to its category', async () => {
    const db = catalogue();
    await run(db);

    expect(db.product.rows.find((row) => row.id === 'lobster')).toMatchObject({
      categoryId: 'fish',
    });
  });

  it('changes nothing when it runs again', async () => {
    const db = catalogue();
    await run(db);
    const snapshot = JSON.stringify(db);

    const log = await run(db);

    expect(JSON.stringify(db)).toBe(snapshot);
    expect(log.every((line) => line.endsWith('already done'))).toBe(true);
  });
});
