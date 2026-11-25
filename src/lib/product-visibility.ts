import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Products a user may see: every global product plus the private ones they created.
 * Anonymous callers (userId null) see global products only.
 */
export function visibleProductsWhere(userId: string | null | undefined): Prisma.ProductWhereInput {
  return {
    OR: [{ isGlobal: true }, ...(userId ? [{ createdById: userId }] : [])],
  };
}

/**
 * List items whose product the user may see. Items created before the write paths enforced
 * visibility can reference another user's private product; reads must not return them.
 */
export function visibleItemsWhere(userId: string | null | undefined): Prisma.ItemWhereInput {
  return { product: visibleProductsWhere(userId) };
}

/**
 * Item.variantId is an independent FK: its variant may belong to another product (legacy rows can
 * point at another user's private variant). The item is already limited to a visible product, so a
 * variant is kept only when it belongs to that same product; otherwise the caller drops it.
 */
export function variantOfItemProduct<T extends { productId: string }>(
  variant: T | null,
  productId: string
): T | null {
  return variant && variant.productId === productId ? variant : null;
}

/**
 * Variants among `variantIds` whose own product the user may see, mapped to that product's id.
 * A variant is visible through its product, never through a snapshot's productId.
 */
export async function visibleVariantProductIds(
  db: Pick<PrismaClient, 'productVariant'>,
  userId: string,
  variantIds: string[]
): Promise<Map<string, string>> {
  if (variantIds.length === 0) return new Map();
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds }, product: visibleProductsWhere(userId) },
    select: { id: true, productId: true },
  });
  return new Map(variants.map((variant) => [variant.id, variant.productId]));
}

/**
 * Snapshot columns survive deletion, so the history row stays. Its variant part is kept only while
 * the variant is still visible to the user and agrees with the snapshot product (when that is set).
 * `visibleVariantProductIds` supplies the visible variants; a null productId keeps a visible variant.
 */
export function keepSnapshotVariant<
  T extends { productId: string | null; variantId: string | null },
>(item: T, visibleVariantProductIdMap: Map<string, string>) {
  if (item.variantId === null) return item;
  const variantProductId = visibleVariantProductIdMap.get(item.variantId);
  const consistent =
    variantProductId !== undefined &&
    (item.productId === null || variantProductId === item.productId);
  if (consistent) return item;
  return {
    ...item,
    variantId: null,
    variantName: null,
    variantNameEn: null,
    variantEmoji: null,
  };
}
