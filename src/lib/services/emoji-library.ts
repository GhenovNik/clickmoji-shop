import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { localizedImagesOf } from '@/lib/product-image';
import { legacyEnglishReferenceExists } from '../../../scripts/lib/legacy-picture-references';

export type EmojiLibrarySource = 'generated' | 'upload' | 'batch';

export type EmojiLibraryInput = {
  imageUrl: string;
  name: string;
  nameEn?: string | null;
  tags?: string[];
  source: EmojiLibrarySource;
  sourceRef?: string | null;
  // null: no text on the picture; 'ru' / 'en': packaging text in that language.
  locale?: string | null;
  groupKey?: string | null;
};

const SEARCH_LIMIT = 48;

function normalizeTags(tags: string[] = []) {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

// Keeps a stored picture in the library. Failing to record never fails the upload that produced
// the picture: the file is already stored and the caller still gets its URL.
export async function recordEmojiLibraryItem(input: EmojiLibraryInput) {
  const data = {
    name: input.name.trim(),
    nameEn: input.nameEn?.trim() || null,
    tags: normalizeTags(input.tags),
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    locale: input.locale ?? null,
    groupKey: input.groupKey ?? null,
  };

  try {
    return await prisma.emojiLibraryItem.upsert({
      where: { imageUrl: input.imageUrl },
      create: { imageUrl: input.imageUrl, ...data },
      update: data,
    });
  } catch (error) {
    console.error('Failed to record emoji library item:', error);
    return null;
  }
}

const LIBRARY_ITEM_SELECT = {
  id: true,
  name: true,
  nameEn: true,
  tags: true,
  imageUrl: true,
  source: true,
  locale: true,
  groupKey: true,
} as const;

// Matching pictures plus the other language of every matched pair, so the result limit never
// splits a Russian picture from its English version.
export async function searchEmojiLibrary(query: string, limit = SEARCH_LIMIT) {
  const q = query.trim();
  const matches = await prisma.emojiLibraryItem.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { nameEn: { contains: q, mode: 'insensitive' } },
            { tags: { has: q.toLowerCase() } },
          ],
        }
      : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), SEARCH_LIMIT),
    select: LIBRARY_ITEM_SELECT,
  });

  const groupKeys = [...new Set(matches.map((item) => item.groupKey).filter(Boolean))] as string[];
  if (groupKeys.length === 0) return matches;
  const siblings = await prisma.emojiLibraryItem.findMany({
    where: { groupKey: { in: groupKeys }, id: { notIn: matches.map((item) => item.id) } },
    select: LIBRARY_ITEM_SELECT,
  });
  return [...matches, ...siblings];
}

// How many products hold the URL in a picture-language entry. The dictionary is read in full:
// a JSON path filter would have to name each language, and a language that is not listed (yet)
// must keep its file as much as a listed one.
async function referencedByDictionary(imageUrl: string, exceptProductId?: string) {
  const rows = await prisma.product.findMany({
    where: {
      localizedImages: { not: Prisma.DbNull },
      ...(exceptProductId && { id: { not: exceptProductId } }),
    },
    select: { localizedImages: true },
  });
  return rows.filter((row) =>
    Object.values(localizedImagesOf(row.localizedImages)).includes(imageUrl)
  ).length;
}

// A stored file may be deleted only when nothing else shows it: no library entry and no other
// product or category. When the check itself fails the answer is "in use", so the file stays.
export async function isStoredImageInUse(
  imageUrl: string,
  except: { productId?: string; categoryId?: string } = {}
) {
  try {
    const [library, products, dictionaries, legacy, categories] = await Promise.all([
      prisma.emojiLibraryItem.count({ where: { imageUrl } }),
      // Any picture of a product keeps the file: the main one, and an entry of the dictionary
      // whatever its language (a language the picture list does not cover yet included).
      prisma.product.count({
        where: {
          imageUrl,
          ...(except.productId && { id: { not: except.productId } }),
        },
      }),
      referencedByDictionary(imageUrl, except.productId),
      // Transitional (until AGE-1667 Ya6 drops the column): the previous release writes only
      // `imageUrlEn`, so a file may be referenced there alone. A boolean existence check, no
      // legacy value is read; a failure keeps the file like every other check here.
      legacyEnglishReferenceExists(prisma, imageUrl, except.productId),
      prisma.category.count({
        where: { imageUrl, ...(except.categoryId && { id: { not: except.categoryId } }) },
      }),
    ]);
    return library + products + dictionaries + categories > 0 || legacy;
  } catch (error) {
    console.error('Failed to check whether a stored image is in use:', error);
    return true;
  }
}
