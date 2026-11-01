// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  libraryCount: vi.fn(),
  productCount: vi.fn(),
  categoryCount: vi.fn(),
  upsert: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    emojiLibraryItem: { count: db.libraryCount, upsert: db.upsert, findMany: db.findMany },
    product: { count: db.productCount },
    category: { count: db.categoryCount },
  },
}));

import { isStoredImageInUse, recordEmojiLibraryItem, searchEmojiLibrary } from './emoji-library';

const URL_A = 'https://utfs.io/f/a.webp';

beforeEach(() => {
  vi.clearAllMocks();
  db.libraryCount.mockResolvedValue(0);
  db.productCount.mockResolvedValue(0);
  db.categoryCount.mockResolvedValue(0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('isStoredImageInUse', () => {
  it('is free to delete when nothing else shows the file', async () => {
    expect(await isStoredImageInUse(URL_A, { productId: 'p1' })).toBe(false);
    expect(db.productCount).toHaveBeenCalledWith({
      where: { OR: [{ imageUrl: URL_A }, { imageUrlEn: URL_A }], id: { not: 'p1' } },
    });
  });

  it('keeps a file that is in the library', async () => {
    db.libraryCount.mockResolvedValue(1);
    expect(await isStoredImageInUse(URL_A, { productId: 'p1' })).toBe(true);
  });

  it('keeps a file that is only the English picture of a product', async () => {
    db.productCount.mockImplementation(async ({ where }) =>
      where.OR.some((condition: { imageUrlEn?: string }) => condition.imageUrlEn === URL_A) ? 1 : 0
    );
    expect(await isStoredImageInUse(URL_A)).toBe(true);
  });

  it('keeps a file another product or category shows', async () => {
    db.productCount.mockResolvedValue(1);
    expect(await isStoredImageInUse(URL_A)).toBe(true);

    db.productCount.mockResolvedValue(0);
    db.categoryCount.mockResolvedValue(1);
    expect(await isStoredImageInUse(URL_A, { categoryId: 'c1' })).toBe(true);
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
