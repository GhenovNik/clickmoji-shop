// @vitest-environment node
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { collectReferencedFileKeys, storedFileKey } from './stored-image-references';

function reader(rows: {
  products?: { imageUrl: string | null; localizedImages?: unknown }[];
  categories?: { imageUrl: string | null; isCustom: boolean }[];
  library?: { imageUrl: string }[];
}) {
  return {
    product: { findMany: vi.fn(async () => rows.products ?? []) },
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
  } as unknown as Pick<PrismaClient, 'product' | 'category' | 'emojiLibraryItem'>;
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
    expect(counts).toEqual({ products: 2, categories: 1, library: 1 });
  });
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
