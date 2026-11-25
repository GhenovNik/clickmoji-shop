import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { normalizeEmail } from '@/lib/auth-security';
import { visibleItemsWhere, visibleProductsWhere } from '@/lib/product-visibility';

export const ACCOUNT_DELETE_PHRASES = {
  ru: 'УДАЛИТЬ',
  en: 'DELETE',
} as const;

function emailLookupFilter(email: string) {
  const normalized = normalizeEmail(email);
  return normalized === email ? email : { in: [email, normalized] };
}

export async function getAccountProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      role: true,
      emailVerified: true,
      createdProductsCount: true,
      createdAt: true,
      updatedAt: true,
      password: true,
    },
  });

  if (!user) return null;

  const { password, ...profile } = user;
  return {
    ...profile,
    hasPassword: Boolean(password),
  };
}

export type ChangePasswordResult =
  | { status: 'updated' }
  | { status: 'not_found' }
  | { status: 'no_local_password' }
  | { status: 'current_password_required' }
  | { status: 'incorrect_current_password' }
  | { status: 'concurrent_change' };

export async function changeAccountPassword(params: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<ChangePasswordResult> {
  const { userId, currentPassword, newPassword } = params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, password: true },
  });

  if (!user) {
    return { status: 'not_found' };
  }

  if (!user.password) {
    return { status: 'no_local_password' };
  }

  if (!currentPassword) {
    return { status: 'current_password_required' };
  }

  const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
  if (!isPasswordValid) {
    return { status: 'incorrect_current_password' };
  }

  const hashedPassword = await bcrypt.hash(newPassword, 12);

  return prisma.$transaction(async (tx) => {
    // Compare-and-swap on the previous password hash ensures concurrent password changes or
    // password resets cannot be silently overwritten.
    const updated = await tx.user.updateMany({
      where: {
        id: userId,
        password: user.password,
      },
      data: {
        password: hashedPassword,
      },
    });

    if (updated.count === 0) {
      const stillExists = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      return stillExists ? { status: 'concurrent_change' } : { status: 'not_found' };
    }

    // Invalidate any outstanding password-reset tokens for this email so old reset links
    // cannot revert the newly set password.
    await tx.passwordResetToken.deleteMany({
      where: { email: emailLookupFilter(user.email) },
    });

    return { status: 'updated' };
  });
}

const exportCategorySelect = {
  id: true,
  name: true,
  nameEn: true,
  emoji: true,
} as const;

const exportProductSelect = {
  id: true,
  name: true,
  nameEn: true,
  emoji: true,
  isCustom: true,
  imageUrl: true,
  imageUrlEn: true,
  isGlobal: true,
  category: { select: exportCategorySelect },
} as const;

const exportVariantSelect = {
  id: true,
  name: true,
  nameEn: true,
  emoji: true,
  imageUrl: true,
  imageUrlEn: true,
} as const;

// Item.variantId is an independent FK: its variant may belong to another product, so the product
// check alone does not cover it. The item row itself is already limited to a visible product; the
// variant is exported only when it belongs to that same product. Otherwise only the variant is dropped.
function sameProductVariant<T extends ExportVariantRow & { productId: string }>(
  variant: T | null,
  productId: string
): ExportVariantRow | null {
  if (!variant || variant.productId !== productId) return null;
  return {
    id: variant.id,
    name: variant.name,
    nameEn: variant.nameEn,
    emoji: variant.emoji,
    imageUrl: variant.imageUrl,
    imageUrlEn: variant.imageUrlEn,
  };
}

// Snapshot columns survive deletion, so the row stays. Its variant part is exported only while the
// variant is still visible to the user and agrees with the snapshot product (when that is still set).
function keepSnapshotVariant<T extends { productId: string | null; variantId: string | null }>(
  item: T,
  visibleVariantProductIds: Map<string, string>
) {
  if (item.variantId === null) return item;
  const variantProductId = visibleVariantProductIds.get(item.variantId);
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

type ExportVariantRow = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  imageUrl: string | null;
  imageUrlEn: string | null;
};

export async function exportAccountData(userId: string) {
  return prisma.$transaction(async (tx) => {
    const profile = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        role: true,
        emailVerified: true,
        createdProductsCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!profile) {
      return null;
    }

    const [rawLists, rawHistories, productFavorites, variantFavorites, createdProducts] =
      await Promise.all([
        tx.list.findMany({
          where: { userId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            name: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
            items: {
              where: visibleItemsWhere(userId),
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                isPurchased: true,
                note: true,
                createdAt: true,
                updatedAt: true,
                purchasedAt: true,
                product: { select: exportProductSelect },
                // productId is read only to match the variant against the item's product.
                variant: { select: { ...exportVariantSelect, productId: true } },
              },
            },
          },
        }),
        tx.listHistory.findMany({
          where: { userId },
          orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
          select: {
            id: true,
            listId: true,
            listName: true,
            completedAt: true,
            createdAt: true,
            items: {
              orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                productId: true,
                variantId: true,
                productName: true,
                productNameEn: true,
                productEmoji: true,
                productImageUrl: true,
                productImageUrlEn: true,
                categoryName: true,
                categoryNameEn: true,
                isCustom: true,
                variantName: true,
                variantNameEn: true,
                variantEmoji: true,
                note: true,
                isPurchased: true,
                addedAt: true,
                createdAt: true,
              },
            },
          },
        }),
        tx.favorite.findMany({
          where: {
            userId,
            product: visibleProductsWhere(userId),
          },
          orderBy: [{ usageCount: 'desc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            usageCount: true,
            createdAt: true,
            updatedAt: true,
            product: { select: exportProductSelect },
          },
        }),
        tx.variantFavorite.findMany({
          where: {
            userId,
            variant: { product: visibleProductsWhere(userId) },
          },
          orderBy: [{ usageCount: 'desc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            usageCount: true,
            createdAt: true,
            updatedAt: true,
            variant: {
              select: {
                ...exportVariantSelect,
                product: { select: exportProductSelect },
              },
            },
          },
        }),
        tx.product.findMany({
          where: { createdById: userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: {
            ...exportProductSelect,
            createdAt: true,
            updatedAt: true,
            variants: { select: exportVariantSelect },
          },
        }),
      ]);

    const snapshotProductIds = [
      ...new Set(
        rawHistories.flatMap((entry) =>
          entry.items.map((item) => item.productId).filter((id): id is string => Boolean(id))
        )
      ),
    ];
    const visibleSnapshotProducts =
      snapshotProductIds.length > 0
        ? await tx.product.findMany({
            where: {
              id: { in: snapshotProductIds },
              ...visibleProductsWhere(userId),
            },
            select: { id: true },
          })
        : [];
    const visibleSnapshotProductIds = new Set(visibleSnapshotProducts.map((product) => product.id));

    const snapshotVariantIds = [
      ...new Set(
        rawHistories.flatMap((entry) =>
          entry.items.map((item) => item.variantId).filter((id): id is string => Boolean(id))
        )
      ),
    ];
    // Variant visibility comes from its own product, not from the snapshot's productId.
    const visibleSnapshotVariants =
      snapshotVariantIds.length > 0
        ? await tx.productVariant.findMany({
            where: {
              id: { in: snapshotVariantIds },
              product: visibleProductsWhere(userId),
            },
            select: { id: true, productId: true },
          })
        : [];
    const visibleSnapshotVariantProductIds = new Map(
      visibleSnapshotVariants.map((variant) => [variant.id, variant.productId])
    );

    // ListHistoryItem.productId uses onDelete: SetNull so a user's own snapshot survives product
    // deletion. Keep nulled-out own snapshots while filtering non-null productIds through
    // visibleProductsWhere so legacy references to another user's private product are never exported.
    const history = rawHistories.map((entry) => ({
      ...entry,
      items: entry.items
        .filter((item) => item.productId === null || visibleSnapshotProductIds.has(item.productId))
        .map((item) => keepSnapshotVariant(item, visibleSnapshotVariantProductIds)),
    }));

    const lists = rawLists.map((list) => ({
      ...list,
      items: list.items.map(({ variant, ...item }) => ({
        ...item,
        variant: sameProductVariant(variant, item.product.id),
      })),
    }));

    const favorites = [
      ...productFavorites.map((favorite) => ({
        id: favorite.id,
        usageCount: favorite.usageCount,
        createdAt: favorite.createdAt,
        updatedAt: favorite.updatedAt,
        product: favorite.product,
        variant: null,
      })),
      ...variantFavorites.map(({ variant: { product, ...variant }, ...favorite }) => ({
        id: favorite.id,
        usageCount: favorite.usageCount,
        createdAt: favorite.createdAt,
        updatedAt: favorite.updatedAt,
        product,
        variant,
      })),
    ].sort((a, b) => b.usageCount - a.usageCount);

    return {
      exportedAt: new Date().toISOString(),
      profile,
      lists,
      history,
      favorites,
      createdProducts,
    };
  });
}

export type DeleteAccountResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'password_required' }
  | { status: 'incorrect_password' }
  | { status: 'confirmation_required' }
  | { status: 'concurrent_change' }
  | { status: 'cross_owner_references' };

export function isValidDeleteConfirmationPhrase(confirmation: string | undefined): boolean {
  if (typeof confirmation !== 'string') return false;
  const normalized = confirmation.trim().toUpperCase();
  return normalized === ACCOUNT_DELETE_PHRASES.en || normalized === ACCOUNT_DELETE_PHRASES.ru;
}

class AccountDeleteAbortedError extends Error {
  constructor(
    public readonly status: 'not_found' | 'concurrent_change' | 'cross_owner_references'
  ) {
    super(`Account deletion aborted: ${status}`);
  }
}

// Other users' rows that the deletion would cascade or SetNull: Item.productId (cascade),
// Item.variantId (SetNull), Favorite (cascade), VariantFavorite (cascade), ListHistoryItem.productId
// and variantId (SetNull), ListHistory.listId (SetNull). Any hit means the deletion must not run.
async function hasCrossOwnerReferences(
  tx: Prisma.TransactionClient,
  userId: string,
  own: { productIds: string[]; variantIds: string[]; listIds: string[] }
): Promise<boolean> {
  const { productIds, variantIds, listIds } = own;
  if (productIds.length === 0 && variantIds.length === 0 && listIds.length === 0) return false;

  const found = await Promise.all([
    tx.item.findFirst({
      where: {
        list: { userId: { not: userId } },
        OR: [{ productId: { in: productIds } }, { variantId: { in: variantIds } }],
      },
      select: { id: true },
    }),
    tx.favorite.findFirst({
      where: { userId: { not: userId }, productId: { in: productIds } },
      select: { id: true },
    }),
    tx.variantFavorite.findFirst({
      where: { userId: { not: userId }, variantId: { in: variantIds } },
      select: { id: true },
    }),
    tx.listHistoryItem.findFirst({
      where: {
        history: { userId: { not: userId } },
        OR: [{ productId: { in: productIds } }, { variantId: { in: variantIds } }],
      },
      select: { id: true },
    }),
    tx.listHistory.findFirst({
      where: { userId: { not: userId }, listId: { in: listIds } },
      select: { id: true },
    }),
  ]);
  return found.some((row) => row !== null);
}

export async function deleteAccount(params: {
  userId: string;
  password?: string;
  confirmation?: string;
}): Promise<DeleteAccountResult> {
  const { userId, password, confirmation } = params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, password: true },
  });

  if (!user) {
    return { status: 'not_found' };
  }

  if (user.password) {
    if (!password) {
      return { status: 'password_required' };
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return { status: 'incorrect_password' };
    }
  } else if (!isValidDeleteConfirmationPhrase(confirmation)) {
    return { status: 'confirmation_required' };
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        // Lock the user row first (`users` -> tokens -> `products`) so deletion, password change,
        // and password reset always acquire locks in the same order and cannot deadlock.
        const lockedUsers = await tx.$queryRaw<
          Array<{ id: string; email: string; password: string | null }>
        >`SELECT id, email, password FROM users WHERE id = ${userId} FOR UPDATE`;
        const current = lockedUsers[0];

        if (!current) {
          return { status: 'not_found' };
        }

        if (current.password !== user.password) {
          return { status: 'concurrent_change' };
        }

        const emailFilter = emailLookupFilter(current.email);
        await tx.emailVerificationToken.deleteMany({
          where: { email: emailFilter },
        });
        await tx.passwordResetToken.deleteMany({
          where: { email: emailFilter },
        });

        // Lock the account's own parent rows before reading any reference to them. An INSERT or
        // UPDATE that points at one of these rows takes FOR KEY SHARE and waits for this lock, and
        // under READ COMMITTED each later read sees every reference committed before the lock.
        // Only rows owned by this account are locked.
        const ownProducts = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM products
          WHERE "createdById" = ${userId} AND "isGlobal" = false
          ORDER BY id
          FOR UPDATE`;
        const ownVariants = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT v.id FROM product_variants v
          JOIN products p ON p.id = v."productId"
          WHERE p."createdById" = ${userId} AND p."isGlobal" = false
          ORDER BY v.id
          FOR UPDATE OF v`;
        const ownLists = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM lists WHERE "userId" = ${userId} ORDER BY id FOR UPDATE`;

        // Refuse rather than cascade or SetNull another user's rows. Throwing rolls back every
        // change above, including the token deletions, so the account and session stay as they were.
        if (
          await hasCrossOwnerReferences(tx, userId, {
            productIds: ownProducts.map((product) => product.id),
            variantIds: ownVariants.map((variant) => variant.id),
            listIds: ownLists.map((list) => list.id),
          })
        ) {
          throw new AccountDeleteAbortedError('cross_owner_references');
        }

        // Remove the user's private products (isGlobal = false) so no orphaned private data stays
        // in the catalog. Global products (isGlobal = true) remain untouched; User deletion sets
        // Product.createdById = null via onDelete: SetNull, preserving other users' lists/favorites.
        await tx.product.deleteMany({
          where: {
            createdById: userId,
            isGlobal: false,
          },
        });

        // Conditional delete (CAS on password) as defense-in-depth: if the password changed
        // concurrently, abort the transaction so token and product deletions roll back atomically.
        const deleted = await tx.user.deleteMany({
          where: {
            id: userId,
            password: user.password,
          },
        });

        if (deleted.count === 0) {
          const stillExists = await tx.user.findUnique({
            where: { id: userId },
            select: { id: true },
          });
          throw new AccountDeleteAbortedError(stillExists ? 'concurrent_change' : 'not_found');
        }

        return { status: 'deleted' };
      },
      // The lock-then-read ordering above relies on READ COMMITTED; make it explicit.
      { isolationLevel: 'ReadCommitted' }
    );
  } catch (error) {
    if (error instanceof AccountDeleteAbortedError) {
      return { status: error.status };
    }
    throw error;
  }
}
