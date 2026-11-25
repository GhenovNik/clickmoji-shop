import type { Prisma } from '@prisma/client';
import { localizedImagesOf, type LocalizedImages } from '../../src/lib/product-image';

// Transitional compatibility for the writers that COPY a picture set into a row that outlives its
// source and cannot be rebuilt later (AGE-1667 Ya3, review round 2). It sits outside `src` for the
// same reason as `legacy-picture-references.ts`: the application does not read the legacy English
// column `products.imageUrlEn` / `product_variants.imageUrlEn`, but the previous release writes
// that column alone, so until the backfill has copied it a row can hold its only English address
// there. A history snapshot is the case that matters: it is taken once, from the catalogue as it is
// at that moment, and never refilled from today's catalogue. A snapshot that missed the legacy
// English address would show a different picture, or none, for ever.
//
// The rule is the one the backfill applies, with the dictionary first: an English entry in the new
// dictionary wins; the legacy value is used only when the dictionary has none. The result is a
// plain dictionary, so the snapshot code downstream (`historyPictureFields`) stays unchanged and no
// legacy value reaches a response or an ordinary read. Ya6 deletes this file with the columns.

// The key of the English entry of the dictionary (`src/lib/image-languages.ts` lists the picture
// languages; the legacy column is English by definition).
const ENGLISH = 'en';

// The dictionary of a row with its legacy English address filled in where the dictionary has no
// English entry. Never changes another entry, never replaces an existing English one.
export function withLegacyEnglish(row: {
  localizedImages?: unknown;
  imageUrlEn?: string | null;
}): LocalizedImages {
  const pictures = localizedImagesOf(row.localizedImages);
  if (pictures[ENGLISH]) return pictures;
  const legacy = localizedImagesOf({ [ENGLISH]: row.imageUrlEn })[ENGLISH];
  return legacy ? { ...pictures, [ENGLISH]: legacy } : pictures;
}

// What a history snapshot copies of a product's pictures, in canonical form.
export type SnapshotPictures = {
  imageUrl: string | null;
  imageTextLocale: string | null;
  localizedImages: LocalizedImages;
};

type Reader = Pick<Prisma.TransactionClient, 'product'>;

// The picture fields of the products that are visible to the user (`where` carries the id list and
// the visibility rule), read in ONE statement: the main picture, its text language, the dictionary
// and the legacy English column come from the same database snapshot, so they cannot disagree with
// each other. The legacy value is folded into the dictionary here and does not leave this function.
// A product that is not visible is not returned, so it has neither a snapshot nor a fallback.
// Call it inside the transaction that creates the snapshot; a failed read throws and rolls the
// completion back instead of writing a snapshot without the English address.
export async function readVisibleSnapshotPictures(
  tx: Reader,
  where: Prisma.ProductWhereInput
): Promise<Map<string, SnapshotPictures>> {
  const rows = await tx.product.findMany({
    where,
    select: {
      id: true,
      imageUrl: true,
      imageTextLocale: true,
      localizedImages: true,
      imageUrlEn: true,
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        imageUrl: row.imageUrl,
        imageTextLocale: row.imageTextLocale,
        localizedImages: withLegacyEnglish(row),
      },
    ])
  );
}
