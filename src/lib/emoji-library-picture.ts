import { IMAGE_LANGUAGES, MAIN_IMAGE_LANGUAGE } from './image-languages';
import { TEXT_LOCALE_NONE } from './product-image';

export type LibraryItem = {
  id: string;
  name: string;
  nameEn: string | null;
  tags: string[];
  imageUrl: string;
  locale?: string | null;
  groupKey?: string | null;
};

// What a product takes from the library: the main picture (Russian label or text-free) and the
// versions in the other picture languages, keyed by language.
export type LibraryPicture = {
  key: string;
  name: string;
  nameEn: string | null;
  tags: string[];
  // null when only other-language versions exist: picking it fills only their pictures.
  imageUrl: string | null;
  // The language of the main picture's text, or 'none'; null when there is no main picture.
  imageTextLocale: string | null;
  localizedImages: Record<string, string>;
};

const isMain = (item: LibraryItem) => !item.locale || item.locale === MAIN_IMAGE_LANGUAGE;

// Language variants of one picture share a groupKey; the picker shows them as one tile and
// gives the product all of them, so picking never puts a foreign label in the main picture.
export function groupLibraryItems(items: LibraryItem[]): LibraryPicture[] {
  const groups = new Map<string, LibraryItem[]>();
  for (const item of items) {
    const key = item.groupKey || item.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.entries()].map(([key, members]) => {
    const main = members.find(isMain);
    // Without a main picture, the labelled version names the group (as the English one did before).
    const shown = (main ?? members.find((item) => !!item.locale) ?? members[0])!;
    const localizedImages: Record<string, string> = {};
    for (const language of IMAGE_LANGUAGES) {
      // The main language's picture is the main picture, never a dictionary entry.
      if (language === MAIN_IMAGE_LANGUAGE) continue;
      const version = members.find((item) => item.locale === language);
      if (version) localizedImages[language] = version.imageUrl;
    }
    return {
      key,
      name: shown.name,
      nameEn: shown.nameEn,
      tags: shown.tags,
      imageUrl: main?.imageUrl ?? null,
      imageTextLocale: main ? (main.locale ?? TEXT_LOCALE_NONE) : null,
      localizedImages,
    };
  });
}
