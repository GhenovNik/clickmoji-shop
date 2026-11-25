// A readable name for a picture language, in the interface language. The picture list names only
// codes, so a language added there gets a label with no further edit: the interface dictionary
// when it has one, otherwise the platform's language names, otherwise the code itself.
export function imageLanguageLabel(
  language: string,
  uiLocale: string,
  dictionary: Readonly<Record<string, string>> = {}
): string {
  const known = dictionary[language];
  if (known) return known;
  try {
    const name = new Intl.DisplayNames([uiLocale], { type: 'language' }).of(language);
    if (name && name.toLowerCase() !== language.toLowerCase()) return name;
  } catch {
    // A code that is not a language tag, or no Intl.DisplayNames: the code is the label.
  }
  return language.toUpperCase();
}
