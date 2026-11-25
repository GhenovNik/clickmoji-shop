// @vitest-environment node
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { collectReferencedFileKeys } from '../../src/lib/services/stored-image-references';
import { legacyEnglishReferenceExists, legacyEnglishReferences } from './legacy-picture-references';

type Row = Record<string, unknown>;

// Only the columns a query selects reach the caller, and a `{ not: null }` filter keeps the rows
// that have the column, as in the database.
function table(rows: Row[]) {
  return {
    findMany: vi.fn(async ({ where, select }: { where?: Row; select: Record<string, true> }) =>
      rows
        .filter((row) =>
          Object.entries(where ?? {}).every(([column, filter]) =>
            filter && typeof filter === 'object' && 'not' in filter
              ? row[column] != null
              : row[column] === filter
          )
        )
        .map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null])))
    ),
  };
}

function db(
  products: Row[],
  variants: Row[] = [],
  history: Row[] = []
): Pick<
  PrismaClient,
  'product' | 'productVariant' | 'listHistoryItem' | 'category' | 'emojiLibraryItem'
> {
  return {
    product: table(products),
    productVariant: table(variants),
    listHistoryItem: table(history),
    category: { findMany: vi.fn(async () => []) },
    emojiLibraryItem: { findMany: vi.fn(async () => []) },
  } as never;
}

describe('legacyEnglishReferences', () => {
  it('lists the legacy English URLs of products, variants and history snapshots', async () => {
    const urls = await legacyEnglishReferences(
      db(
        [{ imageUrlEn: 'https://utfs.io/f/a-en' }, { imageUrl: 'https://utfs.io/f/b' }],
        [{ imageUrlEn: 'https://utfs.io/f/variant-en' }, { imageUrl: 'https://utfs.io/f/v' }],
        [{ productImageUrlEn: 'https://utfs.io/f/history-en' }, { productImageUrl: 'x' }]
      )
    );
    expect(urls.sort()).toEqual([
      'https://utfs.io/f/a-en',
      'https://utfs.io/f/history-en',
      'https://utfs.io/f/variant-en',
    ]);
  });

  it.each([
    ['a product', db([{ imageUrlEn: 'https://utfs.io/f/legacy-only' }]), 'product'],
    [
      'a variant',
      db([], [{ imageUrl: null, imageUrlEn: 'https://utfs.io/f/legacy-only' }]),
      'productVariant',
    ],
    [
      'a history snapshot',
      db([], [], [{ productImageUrl: null, productImageUrlEn: 'https://utfs.io/f/legacy-only' }]),
      'listHistoryItem',
    ],
  ])('keeps a file that only the legacy column of %s references', async (_name, prisma) => {
    const without = await collectReferencedFileKeys(prisma);
    const withLegacy = await collectReferencedFileKeys(prisma, legacyEnglishReferences);

    expect(without.keys.has('legacy-only')).toBe(false);
    expect(withLegacy.keys.has('legacy-only')).toBe(true);
  });

  it.each(['product', 'productVariant', 'listHistoryItem'] as const)(
    'fails instead of returning an empty list when the read of %s fails',
    async (model) => {
      const prisma = db([]);
      (prisma[model].findMany as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('connection lost')
      );
      await expect(legacyEnglishReferences(prisma)).rejects.toThrow('connection lost');
    }
  );
});

describe('legacyEnglishReferenceExists', () => {
  function counters(counts: { product?: number; variant?: number; history?: number } = {}) {
    const product = { count: vi.fn(async () => counts.product ?? 0) };
    const productVariant = { count: vi.fn(async () => counts.variant ?? 0) };
    const listHistoryItem = { count: vi.fn(async () => counts.history ?? 0) };
    return {
      prisma: { product, productVariant, listHistoryItem } as unknown as Pick<
        PrismaClient,
        'product' | 'productVariant' | 'listHistoryItem'
      >,
      product,
      productVariant,
      listHistoryItem,
    };
  }

  it('is a boolean from database counts and returns no legacy value', async () => {
    const found = counters({ product: 2 });
    expect(await legacyEnglishReferenceExists(found.prisma, 'https://utfs.io/f/a')).toBe(true);
    expect(found.product.count).toHaveBeenCalledWith({
      where: { imageUrlEn: 'https://utfs.io/f/a' },
    });
    expect(found.productVariant.count).toHaveBeenCalledWith({
      where: { imageUrlEn: 'https://utfs.io/f/a' },
    });
    expect(found.listHistoryItem.count).toHaveBeenCalledWith({
      where: { productImageUrlEn: 'https://utfs.io/f/a' },
    });

    expect(await legacyEnglishReferenceExists(counters().prisma, 'https://utfs.io/f/a')).toBe(
      false
    );
  });

  it.each([['variant'], ['history']] as const)(
    'is true when only a %s holds the address',
    async (kind) => {
      expect(
        await legacyEnglishReferenceExists(counters({ [kind]: 1 }).prisma, 'https://utfs.io/f/a')
      ).toBe(true);
    }
  );

  it('leaves the excepted product out of the product count only', async () => {
    const none = counters();
    await legacyEnglishReferenceExists(none.prisma, 'https://utfs.io/f/a', 'p1');
    expect(none.product.count).toHaveBeenCalledWith({
      where: { imageUrlEn: 'https://utfs.io/f/a', id: { not: 'p1' } },
    });
    // A variant or snapshot of that product still shows the file.
    expect(none.productVariant.count).toHaveBeenCalledWith({
      where: { imageUrlEn: 'https://utfs.io/f/a' },
    });
    expect(none.listHistoryItem.count).toHaveBeenCalledWith({
      where: { productImageUrlEn: 'https://utfs.io/f/a' },
    });
  });

  it.each(['product', 'productVariant', 'listHistoryItem'] as const)(
    'fails instead of answering "unused" when the count of %s fails',
    async (model) => {
      const failing = counters();
      failing[model].count.mockRejectedValue(new Error('connection lost'));
      await expect(
        legacyEnglishReferenceExists(failing.prisma, 'https://utfs.io/f/a')
      ).rejects.toThrow('connection lost');
    }
  );
});
