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
