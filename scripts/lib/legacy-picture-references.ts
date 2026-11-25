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
