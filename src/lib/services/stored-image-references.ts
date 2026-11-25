import { Prisma, type PrismaClient } from '@prisma/client';
import { localizedImagesOf } from '../product-image';

// Every picture URL the database still points at, from one place for every cleanup command:
// the main picture and every dictionary entry of a product (whatever its language), a category
// picture whatever its isCustom flag says (the stored URL may be shown again), and every library
// picture. A file key is the last path segment of an UploadThing URL.
//
// Nothing here reads the legacy English column (AGE-1667 Ya6 drops it). A cleanup command that must
// still honour a row written before the dictionary was filled passes its own reader as
// `extraReferences` (see scripts/lib/legacy-picture-references.ts).

export function storedFileKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.split('/').pop() || null;
  } catch {
    return null;
  }
}

type ReferenceReader = Pick<PrismaClient, 'product' | 'category' | 'emojiLibraryItem'>;

// URLs the caller knows about besides the ones above. A failed read must throw: the cleanup stops
// instead of deleting a file it could not prove unused.
export type ExtraReferences = (
  prisma: ReferenceReader
) => Promise<Array<string | null | undefined>>;

export async function collectReferencedFileKeys(
  prisma: ReferenceReader,
  extraReferences?: ExtraReferences
) {
  const [products, categories, libraryItems] = await Promise.all([
    prisma.product.findMany({
      where: {
        OR: [{ imageUrl: { not: null } }, { localizedImages: { not: Prisma.DbNull } }],
      },
      select: { imageUrl: true, localizedImages: true },
    }),
    prisma.category.findMany({
      where: { imageUrl: { not: null } },
      select: { imageUrl: true },
    }),
    prisma.emojiLibraryItem.findMany({ select: { imageUrl: true } }),
  ]);

  const extra = extraReferences ? await extraReferences(prisma) : [];

  const urls = [
    ...products.flatMap((product) => [
      product.imageUrl,
      ...Object.values(localizedImagesOf(product.localizedImages)),
    ]),
    ...extra,
    ...categories.map((category) => category.imageUrl),
    ...libraryItems.map((item) => item.imageUrl),
  ];
  const keys = new Set(urls.map(storedFileKey).filter((key): key is string => Boolean(key)));

  return {
    keys,
    counts: {
      products: products.length,
      categories: categories.length,
      library: libraryItems.length,
    },
  };
}
