import { IMAGE_FALLBACK } from './image-languages';

// The one picture selector for products, variants and history rows. It is pure and synchronous,
// so the server and the browser run the same code. Callers pass the stored fields as they are.

export type CatalogLocale = 'ru' | 'en';

// `imageTextLocale`: null or '' = not labelled, 'none' = no text, otherwise the language of the
// text. Unlabelled and 'none' select the same way.
export const TEXT_LOCALE_NONE = 'none';

export type ProductPicture = {
  imageUrl: string | null;
  imageTextLocale?: string | null;
  // Raw JSON column value: {"<language>": "<url>"}. Anything else is ignored.
  localizedImages?: unknown;
};

export type PictureOptions = {
  // Synchronous availability check (for example, a picture already held offline).
  isAvailable?: (url: string) => boolean;
};

export type LocalizedImages = Partial<Record<string, string>>;

function filledUrl(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * The dictionary entries with a filled URL. `languages` limits the result to the listed languages;
 * without it every language is kept.
 */
export function localizedImagesOf(raw: unknown, languages?: readonly string[]): LocalizedImages {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const pictures: LocalizedImages = {};
  for (const [language, value] of Object.entries(raw)) {
    const url = filledUrl(value);
    if (url && (!languages || languages.includes(language))) pictures[language] = url;
  }
  return pictures;
}

/**
 * The five steps of the selection rule, in order, without the availability filter:
 * 1. the dictionary entry for the language;
 * 2. the main picture, when it has no text or its text is in this language;
 * 3. the fallback language's entry (or its main picture, when that is in the fallback language);
 * 4. the main picture, whatever its text;
 * 5. no candidate: the caller shows the emoji.
 */
export function productPictureCandidates(picture: ProductPicture, locale: string): string[] {
  const main = filledUrl(picture.imageUrl);
  const pictures = localizedImagesOf(picture.localizedImages);
  const textLocale = picture.imageTextLocale || null;
  const mainHasNoText = textLocale === null || textLocale === TEXT_LOCALE_NONE;
  const fallback = IMAGE_FALLBACK[locale];

  const steps: Array<string | null | undefined> = [
    pictures[locale],
    main && (mainHasNoText || textLocale === locale) ? main : null,
    fallback ? (pictures[fallback] ?? (main && textLocale === fallback ? main : null)) : null,
    main,
  ];
  return steps.filter((url): url is string => !!url);
}

// Every picture the product holds: the main one first, then the dictionary in its stored order.
export function productPictureUrls(picture: ProductPicture): string[] {
  const urls = [
    filledUrl(picture.imageUrl),
    ...Object.values(localizedImagesOf(picture.localizedImages)),
  ];
  return [...new Set(urls.filter((url): url is string => !!url))];
}

/**
 * The picture to show for `locale`, or null for the emoji. With `isAvailable`, the chain is
 * filtered to available pictures; when none of them is available, any available picture of the
 * product is used; when none is, the result is null.
 */
export function productImageUrl(
  picture: ProductPicture,
  locale: string,
  options: PictureOptions = {}
): string | null {
  const candidates = productPictureCandidates(picture, locale);
  const { isAvailable } = options;
  if (!isAvailable) return candidates[0] ?? null;
  return candidates.find(isAvailable) ?? productPictureUrls(picture).find(isAvailable) ?? null;
}
