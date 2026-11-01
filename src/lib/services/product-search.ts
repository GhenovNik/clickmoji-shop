import { Prisma } from '@prisma/client';
import type { CatalogLocale } from '@/lib/product-image';
import { prisma } from '@/lib/prisma';

export interface ProductSearchResult {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  imageUrlEn: string | null;
  category: {
    id: string;
    name: string;
    nameEn: string;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
  };
  variants?: { id: string; name: string; nameEn: string; emoji: string }[];
  sim_score: number;
  match_priority: number;
}

const SEARCH_LIMIT = 10;

// Fuzzy search over both names (pg_trgm). A product is found by either language, but matches in
// the interface language rank first: a Russian query in the English UI still finds the product,
// and "mil" in the English UI puts Milk above a match on the Russian name only.
export async function searchProducts({
  term,
  userId,
  locale,
}: {
  term: string;
  userId: string | null;
  locale: CatalogLocale;
}) {
  const searchTerm = term.toLowerCase().trim();
  if (!searchTerm) return [];

  const primary = Prisma.raw(locale === 'en' ? 'p."nameEn"' : 'p.name');
  const secondary = Prisma.raw(locale === 'en' ? 'p.name' : 'p."nameEn"');
  const prefix = `${searchTerm}%`;
  const contains = `%${searchTerm}%`;

  const products = await prisma.$queryRaw<ProductSearchResult[]>`
    SELECT
      p.id,
      p.name,
      p."nameEn",
      p.emoji,
      p."isCustom",
      p."imageUrl",
      p."imageUrlEn",
      json_build_object(
        'id', c.id,
        'name', c.name,
        'nameEn', c."nameEn",
        'emoji', c.emoji,
        'isCustom', c."isCustom",
        'imageUrl', c."imageUrl"
      ) as category,
      GREATEST(
        similarity(${primary}, ${searchTerm}),
        similarity(${secondary}, ${searchTerm}) * 0.9
      ) as sim_score,
      CASE
        WHEN LOWER(${primary}) LIKE ${prefix} THEN 6
        WHEN LOWER(${secondary}) LIKE ${prefix} THEN 5
        WHEN LOWER(${primary}) LIKE ${contains} THEN 4
        WHEN LOWER(${secondary}) LIKE ${contains} THEN 3
        ELSE 1
      END as match_priority
    FROM products p
    INNER JOIN categories c ON p."categoryId" = c.id
    WHERE
      (p."isGlobal" = true OR p."createdById" = ${userId})
      AND (
        p.name ILIKE ${contains}
        OR p."nameEn" ILIKE ${contains}
        OR similarity(p.name, ${searchTerm}) > 0.3
        OR similarity(p."nameEn", ${searchTerm}) > 0.3
      )
    ORDER BY match_priority DESC, sim_score DESC, ${primary} ASC
    LIMIT ${SEARCH_LIMIT}
  `;

  const variants = await prisma.productVariant.findMany({
    where: { productId: { in: products.map((product) => product.id) } },
    select: { id: true, name: true, nameEn: true, emoji: true, productId: true },
  });

  const variantsByProduct = new Map<string, NonNullable<ProductSearchResult['variants']>>();
  for (const { productId, ...variant } of variants) {
    variantsByProduct.set(productId, [...(variantsByProduct.get(productId) ?? []), variant]);
  }

  return products.map((product) => ({
    ...product,
    variants: variantsByProduct.get(product.id) ?? [],
  }));
}
