import type { PrismaClient } from '@prisma/client';

// The pictures a file-deleting command must still honour although the application no longer reads
// them: the legacy English columns (AGE-1667 Ya3): `products.imageUrlEn`, `product_variants.imageUrlEn`
// and `list_history_items.productImageUrlEn`. A row written by a release that predates the picture
// dictionary may reference a file only there. The runtime (`src/lib/services/stored-image-references.ts`)
// does not read the columns; the offline cleanup does, until Ya6 drops them. A failed read throws:
// the cleanup stops instead of judging a file unused.
type Reader = Pick<PrismaClient, 'product' | 'productVariant' | 'listHistoryItem'>;

export async function legacyEnglishReferences(prisma: Reader): Promise<string[]> {
  const [products, variants, history] = await Promise.all([
    prisma.product.findMany({
      where: { imageUrlEn: { not: null } },
      select: { imageUrlEn: true },
    }),
    prisma.productVariant.findMany({
      where: { imageUrlEn: { not: null } },
      select: { imageUrlEn: true },
    }),
    prisma.listHistoryItem.findMany({
      where: { productImageUrlEn: { not: null } },
      select: { productImageUrlEn: true },
    }),
  ]);
  return [
    ...products.map((row) => row.imageUrlEn),
    ...variants.map((row) => row.imageUrlEn),
    ...history.map((row) => row.productImageUrlEn),
  ].flatMap((url) => (url ? [url] : []));
}

// Whether any row still points at `imageUrl` in a legacy English column: a product other than
// `exceptProductId`, any variant, any history snapshot (a variant or snapshot of the excepted
// product still shows the file). This is the runtime deletion guard's rollout-compatibility check
// (`isStoredImageInUse`): the previous release writes the legacy columns only, and may do so between
// the Ya2 backfill and the switch of the code, so a file can be referenced there and nowhere else.
// It is a count in the database and returns a boolean, never a legacy value; display and `src`
// still do not read the columns. A failed read throws: the caller treats that as "in use" and keeps
// the file. Remove it with the columns in Ya6.
export async function legacyEnglishReferenceExists(
  prisma: Reader,
  imageUrl: string,
  exceptProductId?: string
): Promise<boolean> {
  const counts = await Promise.all([
    prisma.product.count({
      where: { imageUrlEn: imageUrl, ...(exceptProductId && { id: { not: exceptProductId } }) },
    }),
    prisma.productVariant.count({ where: { imageUrlEn: imageUrl } }),
    prisma.listHistoryItem.count({ where: { productImageUrlEn: imageUrl } }),
  ]);
  return counts.some((count) => count > 0);
}
