import type { Prisma } from '@prisma/client';
import { localizedImagesOf, type LocalizedImages } from '../../src/lib/product-image';

// Transitional compatibility for the writers that COPY a picture set into a row that outlives its
// source and cannot be rebuilt later (AGE-1667 Ya3, review rounds 2 and 3). It sits outside `src`
// for the same reason as `legacy-picture-references.ts`: the application does not read the legacy
// English column `products.imageUrlEn` / `product_variants.imageUrlEn`, but the previous release
// writes that column alone. Until it is stopped and the backfill has run again, the two English
// places of a row can disagree in three ways: the dictionary has none (only the old column holds
// the address), the old writer replaced the address (A in the dictionary, B in the column), or it
// cleared it (A in the dictionary, null in the column). A history snapshot is the case that
// matters: it is taken once, from the catalogue as it is at that moment, and never refilled from
// today's catalogue.
//
// The rule is the one the backfill applies (`planRow`), so a copy and the later backfill agree:
// the legacy column is the source of the English entry, an explicit null included. Every English
// write of the new release stores the dictionary entry and the column together in one statement
// (the product API, the catalogue cleanup, the importer, the history snapshot), so the two can
// differ only because the previous release wrote the column afterwards, and the column is then the
// newer one. The result is a plain dictionary, so the snapshot code downstream
// (`historyPictureFields`) stays unchanged and no legacy value reaches a response or an ordinary
// read, which stays dictionary-only. Ya6 deletes this file with the columns.

// The key of the English entry of the dictionary (`src/lib/image-languages.ts` lists the picture
// languages; the legacy column is English by definition).
const ENGLISH = 'en';

// The dictionary of a row with its English entry taken from the legacy column: the column's address
// replaces the dictionary's, an empty or null column removes it, every other language is kept as
// stored. `imageUrlEn: undefined` means the caller did not read the column, and then nothing can be
// folded in: the dictionary is returned as it is. A caller must read the column in the SAME
// statement as the rest of the row (no later lookup), because an old writer can change it between
// two reads.
export function withLegacyEnglish(row: {
  localizedImages?: unknown;
  imageUrlEn?: string | null;
}): LocalizedImages {
  const pictures = localizedImagesOf(row.localizedImages);
  if (row.imageUrlEn === undefined) return pictures;
  delete pictures[ENGLISH];
  const legacy = localizedImagesOf({ [ENGLISH]: row.imageUrlEn })[ENGLISH];
  return legacy ? { ...pictures, [ENGLISH]: legacy } : pictures;
}

// The write condition of an import that fills a free English slot (AGE-1667 Ya3, review round 4).
// The importer does not read the legacy column, so it cannot tell from its own read that the
// previous release holds the only address of the English picture there (the dictionary has none),
// nor that the previous release wrote one between the importer's read and its write. The condition
// below is part of the same `updateMany` as the dictionary condition (`localizedImages` as read), so
// the database decides both atomically: a row whose legacy column is not empty is not matched, the
// write counts 0 and the importer reports a conflict instead of overwriting or clearing the address.
// It is a write predicate only: nothing is selected, nothing reaches a response. Ya6 deletes it
// with the columns.
export const LEGACY_ENGLISH_UNSET = { imageUrlEn: null } as const;

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
