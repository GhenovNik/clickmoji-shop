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

// One admin edit of the dictionary: only the languages the admin touched. A string sets the
// picture of that language (a blank string removes it), `null` removes it, a language that is not
// in the edit stays exactly as stored. An absent key is "not touched", never "removed": a form
// cannot name a picture it does not show (for example an English address that only the legacy
// column still holds), so it must not be able to erase one by leaving it out.
export type PictureEdit = Partial<Record<string, string | null>>;

// The edit as a plain object, or null when the request carries none that can be read. A value that
// is neither a string nor null is a malformed entry and counts as "not touched".
export function pictureEditOf(raw: unknown): PictureEdit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const edit: PictureEdit = {};
  for (const [language, value] of Object.entries(raw)) {
    if (!IMAGE_LANGUAGES.includes(language)) continue;
    if (value === null) edit[language] = null;
    else if (typeof value === 'string') edit[language] = value.trim() ? value : null;
  }
  return edit;
}

// The dictionary after an admin edit. The edit speaks for the languages it names, and only for
// those listed as picture languages: every other entry (unlisted languages included) is kept as
// stored, and an edit of an unlisted language is ignored, so a stale form or a hand-made request
// can neither erase nor add a language the list does not cover.
export function mergeLocalizedImages(existing: unknown, edit: unknown): LocalizedImages {
  const pictures = { ...localizedImagesOf(existing) };
  for (const [language, value] of Object.entries(pictureEditOf(edit) ?? {})) {
    if (value === null || value === undefined) delete pictures[language];
    else pictures[language] = value;
  }
  return pictures;
}

// Whether an edit names English. Only then is the legacy English column rewritten: an edit that
// leaves English alone must not touch the mirror, because a row written by the previous release
// may hold its English address there alone (until the backfill copies it into the dictionary).
export function editsEnglish(edit: unknown): boolean {
  const picture = pictureEditOf(edit);
  return picture !== null && Object.prototype.hasOwnProperty.call(picture, 'en');
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
