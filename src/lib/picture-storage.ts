import { Prisma } from '@prisma/client';
import { DICTIONARY_LANGUAGES } from './image-languages';
import { localizedImagesOf, type LocalizedImages } from './product-image';

// Server-side helpers for writing picture fields. Reads go through `productImageUrl` only.

// The dictionary as it is stored: only the picture languages of the list, each with a URL.
// An empty dictionary is SQL NULL, the same as a row that was never filled.
export function localizedImagesForStorage(
  raw: unknown,
  languages: readonly string[] = DICTIONARY_LANGUAGES
): Prisma.InputJsonObject | typeof Prisma.DbNull {
  const pictures = localizedImagesOf(raw, languages);
  // Only non-empty string URLs reach this point, so the JSON object type is accurate.
  return Object.keys(pictures).length > 0 ? (pictures as Prisma.InputJsonObject) : Prisma.DbNull;
}

// The legacy English column (`imageUrlEn`) mirrors the English dictionary entry while it exists,
// so a previous release that still reads it keeps showing the same picture.
export function legacyEnglishOf(pictures: LocalizedImages): string | null {
  return pictures.en ?? null;
}

// The picture fields a history row keeps from its product when a list is completed: the main
// picture, its text language and a copy of the dictionary (plus the legacy English column).
export function historyPictureFields(product: {
  imageUrl: string | null;
  imageTextLocale: string | null;
  localizedImages: unknown;
}) {
  const pictures = localizedImagesOf(product.localizedImages, DICTIONARY_LANGUAGES);
  return {
    productImageUrl: product.imageUrl,
    imageTextLocale: product.imageTextLocale,
    localizedImages: localizedImagesForStorage(pictures),
    productImageUrlEn: legacyEnglishOf(pictures),
  };
}
