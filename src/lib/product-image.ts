export type CatalogLocale = 'ru' | 'en';

type LocalizedImage = { imageUrl: string | null; imageUrlEn?: string | null };

// Pictures with text on the packaging exist per language: `imageUrl` carries the Russian (or
// text-free) picture, `imageUrlEn` the English one. English falls back to the main picture,
// Russian never shows the English one.
export function productImageUrl(product: LocalizedImage, locale: CatalogLocale) {
  if (locale === 'en' && product.imageUrlEn) return product.imageUrlEn;
  return product.imageUrl;
}
