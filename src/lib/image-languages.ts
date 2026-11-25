// Languages a product picture can be stored in (`localizedImages`). This list is separate from the
// interface languages: a picture language may exist before its interface translation does.
// Adding a picture language is one line here; the selector, the saved dictionary and the admin
// form follow it. The admin form has one picture field per language that is not the main one.
export const IMAGE_LANGUAGES = ['ru', 'en'] as const;

export type ImageLanguage = (typeof IMAGE_LANGUAGES)[number];

// The main picture (`imageUrl`) is Russian or text-free; it is not stored in the dictionary.
export const MAIN_IMAGE_LANGUAGE = 'ru' as const;

export type DictionaryLanguage = Exclude<ImageLanguage, typeof MAIN_IMAGE_LANGUAGE>;

// The languages whose pictures live in the dictionary.
export const DICTIONARY_LANGUAGES: readonly DictionaryLanguage[] = IMAGE_LANGUAGES.filter(
  (language): language is DictionaryLanguage => language !== MAIN_IMAGE_LANGUAGE
);

// Where a language without a picture of its own borrows from. Languages not listed have none.
export const IMAGE_FALLBACK: Readonly<Record<string, string>> = { es: 'en' };
