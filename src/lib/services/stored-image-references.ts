import { Prisma, type PrismaClient } from '@prisma/client';
import { localizedImagesOf } from '../product-image';

// Every picture URL the database still points at, from one place for every cleanup command:
// both pictures of a product, a category picture whatever its isCustom flag says (the stored URL
// may be shown again), and every library picture. A file key is the last path segment of an
// UploadThing URL.

export function storedFileKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.split('/').pop() || null;
  } catch {
    return null;
  }
}

type ReferenceReader = Pick<PrismaClient, 'product' | 'category' | 'emojiLibraryItem'>;

export async function collectReferencedFileKeys(prisma: ReferenceReader) {
  const [products, categories, libraryItems] = await Promise.all([
    prisma.product.findMany({
      // The legacy English column is read as well: a row written before the dictionary keeps its
      // file referenced here until that column is dropped (AGE-1667 Я6). Deleting a file early is
      // the one loss this check must not cause.
      where: {
        OR: [
          { imageUrl: { not: null } },
          { imageUrlEn: { not: null } },
          { localizedImages: { not: Prisma.DbNull } },
        ],
      },
      select: { imageUrl: true, imageUrlEn: true, localizedImages: true },
    }),
    prisma.category.findMany({
      where: { imageUrl: { not: null } },
      select: { imageUrl: true },
    }),
    prisma.emojiLibraryItem.findMany({ select: { imageUrl: true } }),
  ]);

  const urls = [
    ...products.flatMap((product) => [
      product.imageUrl,
      product.imageUrlEn,
      ...Object.values(localizedImagesOf(product.localizedImages)),
    ]),
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
