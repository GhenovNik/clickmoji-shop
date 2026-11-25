import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { localizedImagesOf } from '@/lib/product-image';
import { legacyEnglishOf } from '@/lib/picture-storage';
import { normalizeEmail } from '@/lib/auth-security';
import {
  keepSnapshotVariant,
  visibleItemsWhere,
  visibleProductsWhere,
  visibleVariantProductIds,
} from '@/lib/product-visibility';

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
      isGuest: true,
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
  imageTextLocale: true,
  localizedImages: true,
  isGlobal: true,
  category: { select: exportCategorySelect },
} as const;

const exportVariantSelect = {
  id: true,
  name: true,
  nameEn: true,
  emoji: true,
  imageUrl: true,
  imageTextLocale: true,
  localizedImages: true,
} as const;

type ExportPictureRow = { imageTextLocale: string | null; localizedImages: unknown };

// The download contract keeps its legacy English key (`imageUrlEn` on products and variants,
// `productImageUrlEn` on history rows). The column is not read: the key is projected from the
// English entry of the picture dictionary, which is what the column mirrors. The dictionary and
// the text language are exported next to it, so a download carries the full picture metadata.
function exportPictures(row: ExportPictureRow) {
  const pictures = localizedImagesOf(row.localizedImages);
  return {
    imageTextLocale: row.imageTextLocale,
    localizedImages: Object.keys(pictures).length > 0 ? pictures : null,
    legacyEnglish: legacyEnglishOf(pictures),
  };
}

function exportPictureFields<T extends ExportPictureRow>(row: T) {
  const { legacyEnglish, ...pictures } = exportPictures(row);
  return { ...row, ...pictures, imageUrlEn: legacyEnglish };
}

function exportHistoryPictureFields<T extends ExportPictureRow>(row: T) {
  const { legacyEnglish, ...pictures } = exportPictures(row);
  return { ...row, ...pictures, productImageUrlEn: legacyEnglish };
}

// Item.variantId is an independent FK: its variant may belong to another product, so the product
// check alone does not cover it. The item row itself is already limited to a visible product; the
// variant is exported only when it belongs to that same product. Otherwise only the variant is dropped.
function sameProductVariant<T extends ExportVariantRow & { productId: string }>(
  variant: T | null,
  productId: string
) {
  if (!variant || variant.productId !== productId) return null;
  return exportPictureFields({
    id: variant.id,
    name: variant.name,
    nameEn: variant.nameEn,
    emoji: variant.emoji,
    imageUrl: variant.imageUrl,
    imageTextLocale: variant.imageTextLocale,
    localizedImages: variant.localizedImages,
  });
}

type ExportVariantRow = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  imageUrl: string | null;
  imageTextLocale: string | null;
  localizedImages: unknown;
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
                imageTextLocale: true,
                localizedImages: true,
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
    const visibleSnapshotVariantProductIds = await visibleVariantProductIds(
      tx,
      userId,
      snapshotVariantIds
    );

    // ListHistoryItem.productId uses onDelete: SetNull so a user's own snapshot survives product
    // deletion. Keep nulled-out own snapshots while filtering non-null productIds through
    // visibleProductsWhere so legacy references to another user's private product are never exported.
    const history = rawHistories.map((entry) => ({
      ...entry,
      items: entry.items
        .filter((item) => item.productId === null || visibleSnapshotProductIds.has(item.productId))
        .map((item) =>
          exportHistoryPictureFields(keepSnapshotVariant(item, visibleSnapshotVariantProductIds))
        ),
    }));

    const lists = rawLists.map((list) => ({
      ...list,
      items: list.items.map(({ variant, product, ...item }) => ({
        ...item,
        product: exportPictureFields(product),
        variant: sameProductVariant(variant, product.id),
      })),
    }));

    const favorites = [
      ...productFavorites.map((favorite) => ({
        id: favorite.id,
        usageCount: favorite.usageCount,
        createdAt: favorite.createdAt,
        updatedAt: favorite.updatedAt,
        product: exportPictureFields(favorite.product),
        variant: null,
      })),
      ...variantFavorites.map(({ variant: { product, ...variant }, ...favorite }) => ({
        id: favorite.id,
        usageCount: favorite.usageCount,
        createdAt: favorite.createdAt,
        updatedAt: favorite.updatedAt,
        product: exportPictureFields(product),
        variant: exportPictureFields(variant),
      })),
    ].sort((a, b) => b.usageCount - a.usageCount);

    return {
      exportedAt: new Date().toISOString(),
      profile,
      lists,
      history,
      favorites,
      createdProducts: createdProducts.map(({ variants, ...product }) => ({
        ...exportPictureFields(product),
        variants: variants.map(exportPictureFields),
      })),
    };
  });
}

export type DeleteAccountResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'password_required' }
  | { status: 'incorrect_password' }
  | { status: 'confirmation_required' }
  | { status: 'guest_account' }
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

// Other users' rows that point at this account's private products: Item.productId (cascade),
// Item.variantId (SetNull; an independent FK, so the variant may sit under another product),
// Favorite and VariantFavorite (cascade), ListHistoryItem.productId and variantId (SetNull).
// Returns the IDs of the products that such rows need. Those products are kept, without an owner,
// instead of being deleted. Other users' lists, favorites and snapshots are never cascaded away.
// Only foreign rows are read; a foreign ListHistory.listId is left to its natural SetNull.
async function referencedProductIds(
  tx: Prisma.TransactionClient,
  userId: string,
  own: { productIds: string[]; variantProductIds: Map<string, string> }
): Promise<Set<string>> {
  const { productIds, variantProductIds } = own;
  const variantIds = [...variantProductIds.keys()];
  const referenced = new Set<string>();
  if (productIds.length === 0 && variantIds.length === 0) return referenced;

  const [items, favorites, variantFavorites, historyItems] = await Promise.all([
    tx.item.findMany({
      where: {
        list: { userId: { not: userId } },
        OR: [{ productId: { in: productIds } }, { variantId: { in: variantIds } }],
      },
      select: { productId: true, variantId: true },
      distinct: ['productId', 'variantId'],
    }),
    tx.favorite.findMany({
      where: { userId: { not: userId }, productId: { in: productIds } },
      select: { productId: true },
      distinct: ['productId'],
    }),
    tx.variantFavorite.findMany({
      where: { userId: { not: userId }, variantId: { in: variantIds } },
      select: { variantId: true },
      distinct: ['variantId'],
    }),
    tx.listHistoryItem.findMany({
      where: {
        history: { userId: { not: userId } },
        OR: [{ productId: { in: productIds } }, { variantId: { in: variantIds } }],
      },
      select: { productId: true, variantId: true },
      distinct: ['productId', 'variantId'],
    }),
  ]);

  // A variant keeps its product: the product is what gets kept, with all of its variants.
  const addVariant = (variantId: string | null) => {
    const owner = variantId ? variantProductIds.get(variantId) : undefined;
    if (owner) referenced.add(owner);
  };
  for (const row of [...items, ...historyItems]) {
    if (row.productId) referenced.add(row.productId);
    addVariant(row.variantId);
  }
  for (const row of favorites) referenced.add(row.productId);
  for (const row of variantFavorites) addVariant(row.variantId);
  return referenced;
}

export async function deleteAccount(params: {
  userId: string;
  password?: string;
  confirmation?: string;
}): Promise<DeleteAccountResult> {
  const { userId, password, confirmation } = params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, password: true, isGuest: true },
  });

  if (!user) {
    return { status: 'not_found' };
  }

  // A guest has no password and no confirmation step in the UI; its row is removed only by the
  // guest cleanup job, never through this endpoint.
  if (user.isGuest) {
    return { status: 'guest_account' };
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

        // Lock every product this account created, global ones included, before reading any
        // reference to them. A visibility or ownership change to one of these rows takes a row lock
        // and waits for this transaction, and an INSERT that points at one takes FOR KEY SHARE and
        // waits too. The private set is then read from the locked row state, and only those IDs are
        // used for the reference checks, the delete and the release. A product that turns private
        // while deletion runs cannot join the set, because its row is already locked here.
        const ownProducts = await tx.$queryRaw<Array<{ id: string; isGlobal: boolean }>>`
          SELECT id, "isGlobal" FROM products
          WHERE "createdById" = ${userId}
          ORDER BY id
          FOR UPDATE`;
        const privateProductIds = ownProducts
          .filter((product) => !product.isGlobal)
          .map((product) => product.id);
        const ownVariants =
          privateProductIds.length === 0
            ? []
            : await tx.$queryRaw<Array<{ id: string; productId: string }>>`
                SELECT v.id, v."productId" FROM product_variants v
                WHERE v."productId" = ANY(${privateProductIds}::text[])
                ORDER BY v.id
                FOR UPDATE OF v`;
        // Own lists stay locked, as before, so a concurrent item insert into them waits for the delete.
        await tx.$queryRaw`
          SELECT id FROM lists WHERE "userId" = ${userId} ORDER BY id FOR UPDATE`;

        // Products that another user's row still points at are kept. Every other private product of
        // this account is deleted, and it cannot cascade anything but this account's own rows.
        const referenced = await referencedProductIds(tx, userId, {
          productIds: privateProductIds,
          variantProductIds: new Map(ownVariants.map((variant) => [variant.id, variant.productId])),
        });
        const keptProductIds = privateProductIds.filter((id) => referenced.has(id));
        const deletableProductIds = privateProductIds.filter((id) => !referenced.has(id));

        const removedProducts = await tx.product.deleteMany({
          where: {
            id: { in: deletableProductIds },
            createdById: userId,
            isGlobal: false,
          },
        });
        if (removedProducts.count !== deletableProductIds.length) {
          throw new AccountDeleteAbortedError('concurrent_change');
        }

        // A kept product becomes private with no owner. visibleProductsWhere matches neither
        // isGlobal nor a creator for it, so nobody else can read it, and the other users' rows that
        // point at it survive the account deletion.
        if (keptProductIds.length > 0) {
          const released = await tx.product.updateMany({
            where: {
              id: { in: keptProductIds },
              createdById: userId,
              isGlobal: false,
            },
            data: { createdById: null },
          });
          if (released.count !== keptProductIds.length) {
            throw new AccountDeleteAbortedError('concurrent_change');
          }
        }

        // Fail closed: a private product still owned by this account was attached to it after the
        // lock above. Deleting the user would orphan it with SetNull, so abort instead.
        const unlockedPrivateProducts = await tx.product.count({
          where: { createdById: userId, isGlobal: false },
        });
        if (unlockedPrivateProducts > 0) {
          throw new AccountDeleteAbortedError('concurrent_change');
        }

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
