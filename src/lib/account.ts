import bcrypt from 'bcryptjs';
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

    const [lists, rawHistories, productFavorites, variantFavorites, createdProducts] =
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
                variant: { select: exportVariantSelect },
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

    // ListHistoryItem.productId uses onDelete: SetNull so a user's own snapshot survives product
    // deletion. Keep nulled-out own snapshots while filtering non-null productIds through
    // visibleProductsWhere so legacy references to another user's private product are never exported.
    const history = rawHistories.map((entry) => ({
      ...entry,
      items: entry.items.filter(
        (item) => item.productId === null || visibleSnapshotProductIds.has(item.productId)
      ),
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
  | { status: 'concurrent_change' };

export function isValidDeleteConfirmationPhrase(confirmation: string | undefined): boolean {
  if (typeof confirmation !== 'string') return false;
  const normalized = confirmation.trim().toUpperCase();
  return normalized === ACCOUNT_DELETE_PHRASES.en || normalized === ACCOUNT_DELETE_PHRASES.ru;
}

class AccountDeleteAbortedError extends Error {
  constructor(public readonly status: 'not_found' | 'concurrent_change') {
    super(`Account deletion aborted: ${status}`);
  }
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
    return await prisma.$transaction(async (tx) => {
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
    });
  } catch (error) {
    if (error instanceof AccountDeleteAbortedError) {
      return { status: error.status };
    }
    throw error;
  }
}
