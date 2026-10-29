import type { Prisma } from '@prisma/client';

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
