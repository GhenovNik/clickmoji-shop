import { Prisma } from '@prisma/client';
import { IMAGE_LANGUAGES } from './image-languages';
import { localizedImagesOf, type LocalizedImages } from './product-image';

// Server-side helpers for writing picture fields. Reads go through `productImageUrl` only.

// The dictionary as it is stored: every entry with a URL, whatever its language. The picture
// language list limits what an admin may EDIT (see `mergeLocalizedImages`), never what a copy keeps:
// an entry of a language that is not listed (yet) survives every write that copies the dictionary.
// An empty dictionary is SQL NULL, the same as a row that was never filled.
export function localizedImagesForStorage(
  raw: unknown
): Prisma.InputJsonObject | typeof Prisma.DbNull {
  const pictures = localizedImagesOf(raw);
  // Only non-empty string URLs reach this point, so the JSON object type is accurate.
  return Object.keys(pictures).length > 0 ? (pictures as Prisma.InputJsonObject) : Prisma.DbNull;
}

// The dictionary after an admin edit. The edit speaks for the listed picture languages only: their
// entries are exactly the edited ones (an absent entry removes the picture). Entries of any other
// language are kept as stored and an edit of one is ignored, so a stale form or a hand-made request
// can neither erase nor add a language the list does not cover.
export function mergeLocalizedImages(existing: unknown, edit: unknown): LocalizedImages {
  const kept = Object.fromEntries(
    Object.entries(localizedImagesOf(existing)).filter(
      ([language]) => !IMAGE_LANGUAGES.includes(language)
    )
  );
  return { ...kept, ...localizedImagesOf(edit, IMAGE_LANGUAGES) };
}

// The legacy English column (`imageUrlEn`) mirrors the English dictionary entry while it exists,
// so a previous release that still reads it keeps showing the same picture. This is a write-only
// rollback path: nothing in `src` reads the column (AGE-1667 Ya6 drops it).
export function legacyEnglishOf(pictures: LocalizedImages): string | null {
  return pictures.en ?? null;
}

// The picture fields a history row keeps from its product when a list is completed: the main
// picture, its text language and a copy of the whole dictionary (plus the legacy English column).
export function historyPictureFields(product: {
  imageUrl: string | null;
  imageTextLocale: string | null;
  localizedImages: unknown;
}) {
  const pictures = localizedImagesOf(product.localizedImages);
  return {
    productImageUrl: product.imageUrl,
    imageTextLocale: product.imageTextLocale,
    localizedImages: localizedImagesForStorage(pictures),
    productImageUrlEn: legacyEnglishOf(pictures),
  };
}
