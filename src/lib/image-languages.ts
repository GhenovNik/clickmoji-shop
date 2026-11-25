// The one list of picture languages: the languages a product picture can be stored in
// (`localizedImages`). It is separate from the interface languages: a picture language may exist
// before its interface translation does.
//
// Adding a picture language is one line here (and, when it needs a stand-in, one line in
// IMAGE_FALLBACK). The selector, the saved dictionary, the admin form, the library picker and the
// batch import follow the list; nothing outside this file names a language.
//
// The list says which languages the ADMIN may edit and which the LIBRARY fills. It never decides
// which dictionary entries are kept: entries of a language that is not (or no longer) listed stay
// in the data and in every copy of it (history snapshots, merged duplicates, edits).
export const IMAGE_LANGUAGES: readonly string[] = ['ru', 'en'];

// The language of the main picture (`imageUrl`) when it has text: a library picture in this
// language, or without a language, becomes the main picture; the other languages become
// dictionary entries. A dictionary entry for this language is still allowed (a product whose main
// picture carries another language's text can hold its Russian version there).
export const MAIN_IMAGE_LANGUAGE = 'ru';

// Where a language without a picture of its own borrows from. Languages not listed have none.
export const IMAGE_FALLBACK: Readonly<Record<string, string>> = { es: 'en' };
