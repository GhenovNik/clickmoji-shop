import type { PrismaClient } from '@prisma/client';

// The pictures a file-deleting command must still honour although the application no longer reads
// them: the legacy English column `products.imageUrlEn` (AGE-1667 Ya3). A row written by a release
// that predates the picture dictionary may reference a file only here. The runtime
// (`src/lib/services/stored-image-references.ts`) does not read the column; the offline cleanup
// does, until Ya6 drops it. A failed read throws: the cleanup stops instead of judging a file unused.
type Reader = Pick<PrismaClient, 'product'>;

export async function legacyEnglishReferences(prisma: Reader): Promise<string[]> {
  const rows = await prisma.product.findMany({
    where: { imageUrlEn: { not: null } },
    select: { imageUrlEn: true },
  });
  return rows.flatMap((row) => (row.imageUrlEn ? [row.imageUrlEn] : []));
}

// Whether any product other than `exceptProductId` still points at `imageUrl` in the legacy column.
// This is the runtime deletion guard's rollout-compatibility check (`isStoredImageInUse`): the
// previous release writes `imageUrlEn` only, and may do so between the Ya2 backfill and the switch
// of the code, so a file can be referenced there and nowhere else. It is a count in the database
// and returns a boolean, never a legacy value; display and `src` still do not read the column.
// A failed read throws: the caller treats that as "in use" and keeps the file. Remove it with the
// column in Ya6.
export async function legacyEnglishReferenceExists(
  prisma: Reader,
  imageUrl: string,
  exceptProductId?: string
): Promise<boolean> {
  const count = await prisma.product.count({
    where: { imageUrlEn: imageUrl, ...(exceptProductId && { id: { not: exceptProductId } }) },
  });
  return count > 0;
}
