import type { CatalogLocale } from '@/lib/product-image';

type LocalizedName = { name: string; nameEn?: string | null };

/** A name per language code. `ru` is the stored Russian name, `en` the English one. */
export type NamesByLocale = Partial<Record<string, string | null | undefined>>;

export type NamePair = {
  /** Shown large, in the interface language; without a name in it, the Russian one. */
  primary: string;
  /** The language code `primary` is written in, for `lang` and hyphenation. */
  primaryLang: string;
  /** Shown small under `primary`: only outside English, when English is filled and differs. */
  secondary?: string;
};

const ENGLISH = 'en';
const BASE = 'ru';

function filled(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The one display rule for catalogue names. The name in the interface language is big. The English
 * name is a small line under it, and only when the interface is not English, English is filled and
 * it differs from the big name. Other languages follow the same rule as long as they have a name.
 */
export function namePair(names: NamesByLocale, locale: string): NamePair {
  const own = filled(names[locale]);
  const primary = own ?? filled(names[BASE]) ?? '';
  const primaryLang = own ? locale : BASE;
  if (locale === ENGLISH) return { primary, primaryLang };

  const english = filled(names[ENGLISH]);
  if (!english || english === primary) return { primary, primaryLang };
  return { primary, primaryLang, secondary: english };
}

/** The Russian and English names of a catalogue entity, as `namePair` takes them. */
export function namesOf(entity: LocalizedName): NamesByLocale {
  return { [BASE]: entity.name, [ENGLISH]: entity.nameEn };
}

export function localizedNamePair(entity: LocalizedName, locale: CatalogLocale): NamePair {
  return namePair(namesOf(entity), locale);
}

// Catalogue entities keep the Russian name in `name` and the English one in `nameEn`. English
// falls back to the Russian name when a translation is missing, Russian never shows English.
export function localizedName(entity: LocalizedName, locale: CatalogLocale) {
  return localizedNamePair(entity, locale).primary;
}
