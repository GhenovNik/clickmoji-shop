export type LibraryItem = {
  id: string;
  name: string;
  nameEn: string | null;
  tags: string[];
  imageUrl: string;
  locale?: string | null;
  groupKey?: string | null;
};

// What a product takes from the library: the main picture (Russian label or text-free) and,
// for a labelled picture, its English version.
export type LibraryPicture = {
  key: string;
  name: string;
  nameEn: string | null;
  tags: string[];
  // null when only the English version exists: picking it fills only the English picture.
  imageUrl: string | null;
  imageUrlEn: string | null;
};

// Language variants of one picture share a groupKey; the picker shows them as one tile and
// gives the product both, so picking never puts an English label in the main picture.
export function groupLibraryItems(items: LibraryItem[]): LibraryPicture[] {
  const groups = new Map<string, LibraryItem[]>();
  for (const item of items) {
    const key = item.groupKey || item.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.entries()].map(([key, members]) => {
    const english = members.find((item) => item.locale === 'en');
    const main = members.find((item) => item.locale !== 'en');
    const shown = (main ?? english)!;
    return {
      key,
      name: shown.name,
      nameEn: shown.nameEn,
      tags: shown.tags,
      // An English label is never offered as the main (Russian or text-free) picture.
      imageUrl: main?.imageUrl ?? null,
      imageUrlEn: english?.imageUrl ?? null,
    };
  });
}
