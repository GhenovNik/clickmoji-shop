import { prisma } from '@/lib/prisma';

export type EmojiLibrarySource = 'generated' | 'upload' | 'batch';

export type EmojiLibraryInput = {
  imageUrl: string;
  name: string;
  nameEn?: string | null;
  tags?: string[];
  source: EmojiLibrarySource;
  sourceRef?: string | null;
  // null: no text on the picture; 'ru' / 'en': packaging text in that language.
  locale?: 'ru' | 'en' | null;
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

export async function searchEmojiLibrary(query: string, limit = SEARCH_LIMIT) {
  const q = query.trim();
  return prisma.emojiLibraryItem.findMany({
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
    select: {
      id: true,
      name: true,
      nameEn: true,
      tags: true,
      imageUrl: true,
      source: true,
      locale: true,
      groupKey: true,
    },
  });
}

// A stored file may be deleted only when nothing else shows it: no library entry and no other
// product or category. When the check itself fails the answer is "in use", so the file stays.
export async function isStoredImageInUse(
  imageUrl: string,
  except: { productId?: string; categoryId?: string } = {}
) {
  try {
    const [library, products, categories] = await Promise.all([
      prisma.emojiLibraryItem.count({ where: { imageUrl } }),
      // Either picture of a product keeps the file: the English one may be the only reference.
      prisma.product.count({
        where: {
          OR: [{ imageUrl }, { imageUrlEn: imageUrl }],
          ...(except.productId && { id: { not: except.productId } }),
        },
      }),
      prisma.category.count({
        where: { imageUrl, ...(except.categoryId && { id: { not: except.categoryId } }) },
      }),
    ]);
    return library + products + categories > 0;
  } catch (error) {
    console.error('Failed to check whether a stored image is in use:', error);
    return true;
  }
}
