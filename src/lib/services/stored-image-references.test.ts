// @vitest-environment node
import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { collectReferencedFileKeys, storedFileKey } from './stored-image-references';

function reader(rows: {
  products?: { imageUrl: string | null; localizedImages?: unknown }[];
  variants?: { imageUrl: string | null; localizedImages?: unknown }[];
  history?: { productImageUrl: string | null; localizedImages?: unknown }[];
  categories?: { imageUrl: string | null; isCustom: boolean }[];
  library?: { imageUrl: string }[];
}) {
  return {
    product: { findMany: vi.fn(async () => rows.products ?? []) },
    productVariant: { findMany: vi.fn(async () => rows.variants ?? []) },
    listHistoryItem: { findMany: vi.fn(async () => rows.history ?? []) },
    // The collector must not filter categories by isCustom; the fake honours only the
    // imageUrl filter, like the database would.
    category: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        (rows.categories ?? []).filter(
          (category) => category.imageUrl && (where.isCustom === undefined || category.isCustom)
        )
      ),
    },
    emojiLibraryItem: { findMany: vi.fn(async () => rows.library ?? []) },
  } as unknown as Pick<
    PrismaClient,
    'product' | 'productVariant' | 'listHistoryItem' | 'category' | 'emojiLibraryItem'
  >;
}

describe('collectReferencedFileKeys', () => {
  it('keeps a category picture whose isCustom flag is off', async () => {
    const { keys } = await collectReferencedFileKeys(
      reader({ categories: [{ imageUrl: 'https://utfs.io/f/category-x', isCustom: false }] })
    );

    expect(keys.has('category-x')).toBe(true);
  });

  it('keeps a file that only a picture-language entry of a product references', async () => {
    const { keys } = await collectReferencedFileKeys(
      reader({
        products: [
          {
            imageUrl: null,
            localizedImages: { en: 'https://utfs.io/f/dictionary-only' },
          },
        ],
      })
    );

    expect(keys.has('dictionary-only')).toBe(true);
  });

  it('collects product, category and library pictures, ignoring empty fields', async () => {
    const { keys, counts } = await collectReferencedFileKeys(
      reader({
        products: [
          {
            imageUrl: 'https://utfs.io/f/main',
            localizedImages: { en: 'https://utfs.io/f/english' },
          },
          {
            imageUrl: null,
            localizedImages: {
              en: 'https://3kv5vvupx6.ufs.sh/f/only-english',
              xx: 'https://utfs.io/f/xx',
            },
          },
        ],
        categories: [{ imageUrl: 'https://utfs.io/f/category', isCustom: true }],
        library: [{ imageUrl: 'https://utfs.io/f/library' }],
      })
    );

    expect([...keys].sort()).toEqual(
      ['category', 'english', 'library', 'main', 'only-english', 'xx'].sort()
    );
    expect(counts).toEqual({
      products: 2,
      variants: 0,
      history: 0,
      categories: 1,
      library: 1,
    });
  });
});

// A variant has its own picture and a history snapshot keeps its product's picture for good: a
// file referenced only there must never be judged unused (AGE-1667 Ya3 review).
describe('collectReferencedFileKeys with variants and history snapshots', () => {
  it('keeps a file only a variant shows, as its main picture or a dictionary entry of any language', async () => {
    const { keys, counts } = await collectReferencedFileKeys(
      reader({
        variants: [
          { imageUrl: 'https://utfs.io/f/variant-main', localizedImages: null },
          { imageUrl: null, localizedImages: { xx: 'https://utfs.io/f/variant-xx' } },
        ],
      })
    );

    expect([...keys].sort()).toEqual(['variant-main', 'variant-xx']);
    expect(counts.variants).toBe(2);
  });

  it('keeps a file only a history snapshot shows, as its main picture or a dictionary entry of any language', async () => {
    const { keys, counts } = await collectReferencedFileKeys(
      reader({
        history: [
          { productImageUrl: 'https://utfs.io/f/history-main', localizedImages: null },
          { productImageUrl: null, localizedImages: { es: 'https://utfs.io/f/history-es' } },
        ],
      })
    );

    expect([...keys].sort()).toEqual(['history-main', 'history-es'].sort());
    expect(counts.history).toBe(2);
  });

  it('reads a variant dictionary and a history dictionary whole, and only the rows that have a picture', async () => {
    const prisma = reader({});
    await collectReferencedFileKeys(prisma);

    expect(prisma.productVariant.findMany).toHaveBeenCalledWith({
      where: { OR: [{ imageUrl: { not: null } }, { localizedImages: { not: Prisma.DbNull } }] },
      select: { imageUrl: true, localizedImages: true },
    });
    expect(prisma.listHistoryItem.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ productImageUrl: { not: null } }, { localizedImages: { not: Prisma.DbNull } }],
      },
      select: { productImageUrl: true, localizedImages: true },
    });
  });

  it('does not keep a file nothing references, and ignores malformed dictionaries', async () => {
    const { keys } = await collectReferencedFileKeys(
      reader({
        products: [{ imageUrl: 'https://utfs.io/f/product-main' }],
        variants: [{ imageUrl: null, localizedImages: 'broken' }],
        history: [{ productImageUrl: null, localizedImages: ['x'] }],
      })
    );

    expect([...keys]).toEqual(['product-main']);
    expect(keys.has('unreferenced')).toBe(false);
  });

  it.each(['productVariant', 'listHistoryItem'] as const)(
    'stops the collection when the read of %s fails, so nothing is judged unused',
    async (model) => {
      const prisma = reader({});
      (prisma[model].findMany as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('connection lost')
      );

      await expect(collectReferencedFileKeys(prisma)).rejects.toThrow('connection lost');
    }
  );
});

describe('collectReferencedFileKeys with an extra reference reader', () => {
  it('keeps a file that only the extra reader knows', async () => {
    const extra = vi.fn(async () => ['https://utfs.io/f/legacy-only', null]);
    const { keys } = await collectReferencedFileKeys(reader({}), extra);

    expect(keys.has('legacy-only')).toBe(true);
    expect(extra).toHaveBeenCalledTimes(1);
  });

  it('stops the collection when the extra reader fails, so nothing is judged unused', async () => {
    const extra = vi.fn(async () => {
      throw new Error('column does not exist');
    });

    await expect(collectReferencedFileKeys(reader({}), extra)).rejects.toThrow(
      'column does not exist'
    );
  });
});

describe('storedFileKey', () => {
  it('takes the last path segment and ignores what is not a URL', () => {
    expect(storedFileKey('https://utfs.io/f/abc.webp')).toBe('abc.webp');
    expect(storedFileKey('not a url')).toBeNull();
    expect(storedFileKey(null)).toBeNull();
  });
});
