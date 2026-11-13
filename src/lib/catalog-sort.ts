import { localizedName } from '@/lib/catalog-name';

type Named = { name: string; nameEn?: string | null };

// English compares what the visitor sees; Russian and anything unrecognised keep the database
// order, which `orderBy: { name: 'asc' }` already provides. Non-en input is returned untouched.
export function sortByDisplayedName<T extends Named>(products: T[], locale: string): T[] {
  if (locale !== 'en') return products;
  const collator = new Intl.Collator('en', { sensitivity: 'base' });
  return [...products].sort((a, b) =>
    collator.compare(localizedName(a, 'en'), localizedName(b, 'en'))
  );
}
