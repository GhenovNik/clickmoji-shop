import type { CatalogLocale } from '@/lib/product-image';

type LocalizedName = { name: string; nameEn?: string | null };

// Catalogue entities keep the Russian name in `name` and the English one in `nameEn`. English
// falls back to the Russian name when a translation is missing, Russian never shows English.
export function localizedName(entity: LocalizedName, locale: CatalogLocale) {
  if (locale === 'en' && entity.nameEn?.trim()) return entity.nameEn;
  return entity.name;
}
