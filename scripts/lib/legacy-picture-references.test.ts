// @vitest-environment node
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { collectReferencedFileKeys } from '../../src/lib/services/stored-image-references';
import { legacyEnglishReferenceExists, legacyEnglishReferences } from './legacy-picture-references';

function db(
  products: Array<{
    imageUrl?: string | null;
    imageUrlEn?: string | null;
    localizedImages?: unknown;
  }>
) {
  return {
    product: {
      // Only the columns the query selects reach the caller, as in the database.
      findMany: vi.fn(
        async ({ where, select }: { where?: unknown; select: Record<string, true> }) =>
          products
            .filter((product) => {
              const clause = where as { imageUrlEn?: unknown; OR?: unknown } | undefined;
              return clause?.imageUrlEn ? product.imageUrlEn != null : true;
            })
            .map((product) =>
              Object.fromEntries(
                Object.keys(select).map((key) => [
                  key,
                  (product as Record<string, unknown>)[key] ?? null,
                ])
              )
            )
      ),
    },
    category: { findMany: vi.fn(async () => []) },
    emojiLibraryItem: { findMany: vi.fn(async () => []) },
  } as unknown as Pick<PrismaClient, 'product' | 'category' | 'emojiLibraryItem'>;
}

describe('legacyEnglishReferences', () => {
  it('lists the legacy English URLs of products', async () => {
    const urls = await legacyEnglishReferences(
      db([{ imageUrlEn: 'https://utfs.io/f/a-en' }, { imageUrl: 'https://utfs.io/f/b' }])
    );
    expect(urls).toEqual(['https://utfs.io/f/a-en']);
  });

  it('keeps a file that only the legacy column references when passed to the collector', async () => {
    const prisma = db([{ imageUrl: null, imageUrlEn: 'https://utfs.io/f/legacy-only' }]);

    const without = await collectReferencedFileKeys(prisma);
    const withLegacy = await collectReferencedFileKeys(prisma, legacyEnglishReferences);

    expect(without.keys.has('legacy-only')).toBe(false);
    expect(withLegacy.keys.has('legacy-only')).toBe(true);
  });

  it('fails instead of returning an empty list when the read fails', async () => {
    const prisma = db([]);
    (prisma.product.findMany as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('connection lost')
    );
    await expect(legacyEnglishReferences(prisma)).rejects.toThrow('connection lost');
  });
});

describe('legacyEnglishReferenceExists', () => {
  function counter(count: number) {
    const product = { count: vi.fn(async () => count) };
    return {
      prisma: { product } as unknown as Pick<PrismaClient, 'product'>,
      count: product.count,
    };
  }

  it('is a boolean from a database count and returns no legacy value', async () => {
    const found = counter(2);
    expect(await legacyEnglishReferenceExists(found.prisma, 'https://utfs.io/f/a')).toBe(true);
    expect(found.count).toHaveBeenCalledWith({ where: { imageUrlEn: 'https://utfs.io/f/a' } });

    expect(await legacyEnglishReferenceExists(counter(0).prisma, 'https://utfs.io/f/a')).toBe(
      false
    );
  });

  it('leaves the excepted product out of the count', async () => {
    const none = counter(0);
    await legacyEnglishReferenceExists(none.prisma, 'https://utfs.io/f/a', 'p1');
    expect(none.count).toHaveBeenCalledWith({
      where: { imageUrlEn: 'https://utfs.io/f/a', id: { not: 'p1' } },
    });
  });

  it('fails instead of answering "unused" when the count fails', async () => {
    const failing = counter(0);
    failing.count.mockRejectedValue(new Error('connection lost'));
    await expect(
      legacyEnglishReferenceExists(failing.prisma, 'https://utfs.io/f/a')
    ).rejects.toThrow('connection lost');
  });
});
