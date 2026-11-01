// @vitest-environment node
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { collectReferencedFileKeys, storedFileKey } from './stored-image-references';

function reader(rows: {
  products?: { imageUrl: string | null; imageUrlEn: string | null }[];
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

  it('collects both product pictures, categories and the library, ignoring empty fields', async () => {
    const { keys, counts } = await collectReferencedFileKeys(
      reader({
        products: [
          { imageUrl: 'https://utfs.io/f/main', imageUrlEn: 'https://utfs.io/f/english' },
          { imageUrl: null, imageUrlEn: 'https://3kv5vvupx6.ufs.sh/f/only-english' },
        ],
        categories: [{ imageUrl: 'https://utfs.io/f/category', isCustom: true }],
        library: [{ imageUrl: 'https://utfs.io/f/library' }],
      })
    );

    expect([...keys].sort()).toEqual(
      ['category', 'english', 'library', 'main', 'only-english'].sort()
    );
    expect(counts).toEqual({ products: 2, categories: 1, library: 1 });
  });
});

describe('storedFileKey', () => {
  it('takes the last path segment and ignores what is not a URL', () => {
    expect(storedFileKey('https://utfs.io/f/abc.webp')).toBe('abc.webp');
    expect(storedFileKey('not a url')).toBeNull();
    expect(storedFileKey(null)).toBeNull();
  });
});
