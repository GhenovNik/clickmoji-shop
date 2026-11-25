// @vitest-environment node
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  libraryCount: vi.fn(),
  productCount: vi.fn(),
  productFindMany: vi.fn(),
  variantCount: vi.fn(),
  variantFindMany: vi.fn(),
  historyCount: vi.fn(),
  historyFindMany: vi.fn(),
  categoryCount: vi.fn(),
  upsert: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    emojiLibraryItem: { count: db.libraryCount, upsert: db.upsert, findMany: db.findMany },
    product: { count: db.productCount, findMany: db.productFindMany },
    productVariant: { count: db.variantCount, findMany: db.variantFindMany },
    listHistoryItem: { count: db.historyCount, findMany: db.historyFindMany },
    category: { count: db.categoryCount },
  },
}));

import { isStoredImageInUse, recordEmojiLibraryItem, searchEmojiLibrary } from './emoji-library';

const URL_A = 'https://utfs.io/f/a.webp';

beforeEach(() => {
  vi.clearAllMocks();
  db.libraryCount.mockResolvedValue(0);
  db.productCount.mockResolvedValue(0);
  db.productFindMany.mockResolvedValue([]);
  db.variantCount.mockResolvedValue(0);
  db.variantFindMany.mockResolvedValue([]);
  db.historyCount.mockResolvedValue(0);
  db.historyFindMany.mockResolvedValue([]);
  db.categoryCount.mockResolvedValue(0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('isStoredImageInUse', () => {
  it('is free to delete when nothing else shows the file', async () => {
    expect(await isStoredImageInUse(URL_A, { productId: 'p1' })).toBe(false);
    expect(db.productCount).toHaveBeenCalledWith({
      where: { imageUrl: URL_A, id: { not: 'p1' } },
    });
    // The dictionary is read whole, so no language has to be named to protect its file.
    expect(db.productFindMany).toHaveBeenCalledWith({
      where: { localizedImages: { not: Prisma.DbNull }, id: { not: 'p1' } },
      select: { localizedImages: true },
    });
  });

  it('keeps a file that is in the library', async () => {
    db.libraryCount.mockResolvedValue(1);
    expect(await isStoredImageInUse(URL_A, { productId: 'p1' })).toBe(true);
  });

  it.each(['en', 'ru', 'es', 'xx'])(
    'keeps a file that is only the %s picture of a product, listed language or not',
    async (language) => {
      db.productFindMany.mockResolvedValue([
        { localizedImages: { en: 'https://utfs.io/f/other.webp' } },
        { localizedImages: { [language]: URL_A } },
      ]);
      expect(await isStoredImageInUse(URL_A)).toBe(true);
    }
  );

  it('ignores a dictionary that only holds other files or is malformed', async () => {
    db.productFindMany.mockResolvedValue([
      { localizedImages: { en: 'https://utfs.io/f/other.webp' } },
      { localizedImages: 'broken' },
    ]);
    expect(await isStoredImageInUse(URL_A)).toBe(false);
  });

  it('keeps a file another product or category shows', async () => {
    db.productCount.mockResolvedValue(1);
    expect(await isStoredImageInUse(URL_A)).toBe(true);

    db.productCount.mockResolvedValue(0);
    db.categoryCount.mockResolvedValue(1);
    expect(await isStoredImageInUse(URL_A, { categoryId: 'c1' })).toBe(true);
  });

  describe('legacy English column (rollout compatibility until AGE-1667 Ya6)', () => {
    // One mocked `count` per table serves both checks: tell them apart by the column they filter.
    function countOnly(column: 'imageUrl' | 'imageUrlEn') {
      db.productCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        column in where ? 1 : 0
      );
    }

    it('refuses to delete a file that only the legacy column references', async () => {
      // The previous release wrote imageUrlEn alone: no main picture, no dictionary entry.
      countOnly('imageUrlEn');
      expect(await isStoredImageInUse(URL_A)).toBe(true);
      expect(db.productCount).toHaveBeenCalledWith({ where: { imageUrlEn: URL_A } });
    });

    it('refuses to delete a file that only a variant or a history row holds in its legacy column', async () => {
      db.variantCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        'imageUrlEn' in where ? 1 : 0
      );
      expect(await isStoredImageInUse(URL_A)).toBe(true);
      expect(db.variantCount).toHaveBeenCalledWith({ where: { imageUrlEn: URL_A } });

      db.variantCount.mockResolvedValue(0);
      db.historyCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        'productImageUrlEn' in where ? 1 : 0
      );
      expect(await isStoredImageInUse(URL_A)).toBe(true);
      expect(db.historyCount).toHaveBeenCalledWith({ where: { productImageUrlEn: URL_A } });
    });

    it('does not count the product being edited, as for every other picture', async () => {
      db.productCount.mockResolvedValue(0);
      expect(await isStoredImageInUse(URL_A, { productId: 'p1' })).toBe(false);
      expect(db.productCount).toHaveBeenCalledWith({
        where: { imageUrlEn: URL_A, id: { not: 'p1' } },
      });
    });

    it('still deletes a file nothing references, legacy column included', async () => {
      expect(await isStoredImageInUse(URL_A)).toBe(false);
    });

    it.each([
      ['product', db.productCount, 'imageUrlEn'],
      ['variant', db.variantCount, 'imageUrlEn'],
      ['history', db.historyCount, 'productImageUrlEn'],
    ])('keeps the file when the legacy check of %s fails', async (_name, count, column) => {
      count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        if (column in where) throw new Error(`column "${column}" does not exist`);
        return 0;
      });
      expect(await isStoredImageInUse(URL_A)).toBe(true);
    });
  });

  // A variant has its own picture, and a history snapshot keeps the picture of its product: a file
  // referenced only there is still shown (AGE-1667 Ya3 review).
  describe('variants and history snapshots', () => {
    it('counts both of them in the main picture check, even for the product being edited', async () => {
      expect(await isStoredImageInUse(URL_A, { productId: 'p1' })).toBe(false);
      expect(db.variantCount).toHaveBeenCalledWith({ where: { imageUrl: URL_A } });
      expect(db.historyCount).toHaveBeenCalledWith({ where: { productImageUrl: URL_A } });
    });

    it('keeps a file only a variant shows as its main picture', async () => {
      db.variantCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        'imageUrl' in where ? 1 : 0
      );
      expect(await isStoredImageInUse(URL_A)).toBe(true);
    });

    it('keeps a file only a history snapshot shows as its main picture', async () => {
      db.historyCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        'productImageUrl' in where ? 1 : 0
      );
      expect(await isStoredImageInUse(URL_A)).toBe(true);
    });

    it.each(['en', 'ru', 'es', 'xx'])(
      'keeps a file that is only the %s picture of a variant, listed language or not',
      async (language) => {
        db.variantFindMany.mockResolvedValue([
          { localizedImages: { en: 'https://utfs.io/f/other.webp' } },
          { localizedImages: { [language]: URL_A } },
        ]);
        expect(await isStoredImageInUse(URL_A)).toBe(true);
        expect(db.variantFindMany).toHaveBeenCalledWith({
          where: { localizedImages: { not: Prisma.DbNull } },
          select: { localizedImages: true },
        });
      }
    );

    it.each(['en', 'ru', 'es', 'xx'])(
      'keeps a file that is only the %s picture of a history snapshot, listed language or not',
      async (language) => {
        db.historyFindMany.mockResolvedValue([{ localizedImages: { [language]: URL_A } }]);
        expect(await isStoredImageInUse(URL_A)).toBe(true);
        expect(db.historyFindMany).toHaveBeenCalledWith({
          where: { localizedImages: { not: Prisma.DbNull } },
          select: { localizedImages: true },
        });
      }
    );

    it('deletes a file that nothing references, whatever the other dictionaries hold', async () => {
      db.variantFindMany.mockResolvedValue([
        { localizedImages: { en: 'https://utfs.io/f/other.webp' } },
        { localizedImages: 'broken' },
      ]);
      db.historyFindMany.mockResolvedValue([{ localizedImages: ['x'] }]);
      expect(await isStoredImageInUse(URL_A)).toBe(false);
    });

    it.each([
      ['variant count', db.variantCount],
      ['variant dictionaries', db.variantFindMany],
      ['history count', db.historyCount],
      ['history dictionaries', db.historyFindMany],
    ])('keeps the file when the read of %s fails', async (_name, read) => {
      read.mockRejectedValue(new Error('connection lost'));
      expect(await isStoredImageInUse(URL_A)).toBe(true);
    });
  });

  it('keeps the file when reading the dictionaries fails', async () => {
    db.productFindMany.mockRejectedValue(new Error('connection lost'));
    expect(await isStoredImageInUse(URL_A)).toBe(true);
  });

  it('keeps the file when the check fails, e.g. before the migration is applied', async () => {
    db.libraryCount.mockRejectedValue(new Error('relation "emoji_library_items" does not exist'));
    expect(await isStoredImageInUse(URL_A)).toBe(true);
  });
});

describe('recordEmojiLibraryItem', () => {
  it('upserts by URL with trimmed names and unique lower-case tags', async () => {
    db.upsert.mockResolvedValue({ id: 'e1' });

    await recordEmojiLibraryItem({
      imageUrl: URL_A,
      name: ' Кабачок ',
      nameEn: ' Zucchini ',
      tags: ['Овощи', 'овощи ', ''],
      source: 'batch',
      sourceRef: 'batch-001#1',
    });

    const data = {
      name: 'Кабачок',
      nameEn: 'Zucchini',
      tags: ['овощи'],
      source: 'batch',
      sourceRef: 'batch-001#1',
      locale: null,
      groupKey: null,
    };
    expect(db.upsert).toHaveBeenCalledWith({
      where: { imageUrl: URL_A },
      create: { imageUrl: URL_A, ...data },
      update: data,
    });
  });

  it('never fails the upload that produced the picture', async () => {
    db.upsert.mockRejectedValue(new Error('db down'));
    await expect(
      recordEmojiLibraryItem({ imageUrl: URL_A, name: 'x', source: 'upload' })
    ).resolves.toBeNull();
  });
});

describe('searchEmojiLibrary', () => {
  it('matches names case-insensitively and tags exactly', async () => {
    db.findMany.mockResolvedValue([]);
    await searchEmojiLibrary('  Капуста ');
    expect(db.findMany.mock.calls[0][0].where).toEqual({
      OR: [
        { name: { contains: 'Капуста', mode: 'insensitive' } },
        { nameEn: { contains: 'Капуста', mode: 'insensitive' } },
        { tags: { has: 'капуста' } },
      ],
    });
  });

  it('adds the other language of every matched pair', async () => {
    db.findMany
      .mockResolvedValueOnce([{ id: 'en', groupKey: 'text-001#2', locale: 'en' }])
      .mockResolvedValueOnce([{ id: 'ru', groupKey: 'text-001#2', locale: 'ru' }]);

    const items = await searchEmojiLibrary('kefir');

    expect(items.map((item) => item.id)).toEqual(['en', 'ru']);
    expect(db.findMany.mock.calls[1][0].where).toEqual({
      groupKey: { in: ['text-001#2'] },
      id: { notIn: ['en'] },
    });
  });

  it('lists the newest pictures for an empty query, capped', async () => {
    db.findMany.mockResolvedValue([]);
    await searchEmojiLibrary('', 1000);
    expect(db.findMany.mock.calls[0][0]).toMatchObject({
      where: undefined,
      orderBy: { createdAt: 'desc' },
      take: 48,
    });
  });
});
