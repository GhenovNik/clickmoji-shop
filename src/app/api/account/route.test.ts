// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  password: string | null;
  image: string | null;
  role: 'USER' | 'ADMIN';
  emailVerified: Date | null;
  createdProductsCount: number;
  createdAt: Date;
  updatedAt: Date;
};

type TokenRow = { id: string; email: string; token: string; expiresAt: Date; createdAt: Date };

type CategoryRow = { id: string; name: string; nameEn: string; emoji: string };

type ProductRow = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  imageUrlEn: string | null;
  categoryId: string;
  isGlobal: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type VariantRow = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  imageUrl: string | null;
  imageUrlEn: string | null;
  productId: string;
};

type ListRow = {
  id: string;
  name: string;
  isActive: boolean;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
};

type ItemRow = {
  id: string;
  listId: string;
  productId: string;
  variantId: string | null;
  isPurchased: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  purchasedAt: Date | null;
};

type FavoriteRow = {
  id: string;
  userId: string;
  productId: string;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
};

type VariantFavoriteRow = {
  id: string;
  userId: string;
  variantId: string;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
};

type HistoryRow = {
  id: string;
  userId: string;
  listId: string | null;
  listName: string;
  completedAt: Date;
  createdAt: Date;
};

type HistoryItemRow = {
  id: string;
  historyId: string;
  productId: string | null;
  variantId: string | null;
  productName: string;
  productNameEn: string | null;
  productEmoji: string;
  productImageUrl: string | null;
  productImageUrlEn: string | null;
  categoryName: string;
  categoryNameEn: string | null;
  isCustom: boolean;
  variantName: string | null;
  variantNameEn: string | null;
  variantEmoji: string | null;
  note: string | null;
  isPurchased: boolean;
  addedAt: Date;
  createdAt: Date;
};

const db = {
  users: [] as UserRow[],
  emailTokens: [] as TokenRow[],
  resetTokens: [] as TokenRow[],
  categories: [] as CategoryRow[],
  products: [] as ProductRow[],
  variants: [] as VariantRow[],
  lists: [] as ListRow[],
  items: [] as ItemRow[],
  favorites: [] as FavoriteRow[],
  variantFavorites: [] as VariantFavoriteRow[],
  histories: [] as HistoryRow[],
  historyItems: [] as HistoryItemRow[],
  aiUsage: [] as Array<{ userId: string }>,
  funnelEvents: [] as Array<{ id: string; userId: string | null }>,
};

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') {
      return (value as Record<string, unknown>[]).some((clause) => matches(row, clause));
    }
    if (key === 'AND') {
      return (value as Record<string, unknown>[]).every((clause) => matches(row, clause));
    }
    if (key === 'product') {
      const product = db.products.find((p) => p.id === row.productId);
      return product
        ? matches(product as unknown as Record<string, unknown>, value as Record<string, unknown>)
        : false;
    }
    if (key === 'variant') {
      const variant = db.variants.find((v) => v.id === row.variantId);
      if (!variant) return false;
      const vWhere = value as Record<string, unknown>;
      if ('product' in vWhere) {
        const product = db.products.find((p) => p.id === variant.productId);
        return product
          ? matches(
              product as unknown as Record<string, unknown>,
              vWhere.product as Record<string, unknown>
            )
          : false;
      }
      return matches(variant as unknown as Record<string, unknown>, vWhere);
    }
    if (value && typeof value === 'object' && 'in' in value) {
      return (value.in as unknown[]).includes(row[key]);
    }
    if (value && typeof value === 'object' && 'lt' in value) {
      return (row[key] as Date) < (value.lt as Date);
    }
    return row[key] === value;
  });
}

function pickSelected<T extends Record<string, unknown>>(row: T, select?: Record<string, unknown>) {
  if (!select) return { ...row };
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    if (!spec) continue;
    result[key] = row[key];
  }
  return result;
}

function cascadeDeleteProducts(productIds: string[]) {
  if (productIds.length === 0) return;
  const idSet = new Set(productIds);
  const removedVariantIds = new Set(
    db.variants.filter((v) => idSet.has(v.productId)).map((v) => v.id)
  );
  db.products = db.products.filter((p) => !idSet.has(p.id));
  db.variants = db.variants.filter((v) => !idSet.has(v.productId));
  db.items = db.items.filter((i) => !idSet.has(i.productId));
  db.favorites = db.favorites.filter((f) => !idSet.has(f.productId));
  db.variantFavorites = db.variantFavorites.filter((vf) => !removedVariantIds.has(vf.variantId));
  db.historyItems = db.historyItems.map((hi) =>
    hi.productId && idSet.has(hi.productId) ? { ...hi, productId: null, variantId: null } : hi
  );
}

const doubles = vi.hoisted(() => ({
  requireUser: vi.fn(),
  onBeforePasswordUpdateTx: vi.fn<() => void | Promise<void>>(),
  onBeforeDeleteLock: vi.fn<() => void | Promise<void>>(),
  onAfterDeleteLock: vi.fn<() => void | Promise<void>>(),
  onAfterResetLock: vi.fn<() => void | Promise<void>>(),
  onBeforeUserDeleteMany: vi.fn<() => void | Promise<void>>(),
}));

type TxTraceEntry = { tx: number; table: string; op: string };
const txTrace: TxTraceEntry[] = [];

function snapshotDb() {
  return {
    users: db.users.map((row) => ({ ...row })),
    emailTokens: db.emailTokens.map((row) => ({ ...row })),
    resetTokens: db.resetTokens.map((row) => ({ ...row })),
    categories: db.categories.map((row) => ({ ...row })),
    products: db.products.map((row) => ({ ...row })),
    variants: db.variants.map((row) => ({ ...row })),
    lists: db.lists.map((row) => ({ ...row })),
    items: db.items.map((row) => ({ ...row })),
    favorites: db.favorites.map((row) => ({ ...row })),
    variantFavorites: db.variantFavorites.map((row) => ({ ...row })),
    histories: db.histories.map((row) => ({ ...row })),
    historyItems: db.historyItems.map((row) => ({ ...row })),
    aiUsage: db.aiUsage.map((row) => ({ ...row })),
    funnelEvents: db.funnelEvents.map((row) => ({ ...row })),
  };
}

function restoreDb(snapshot: ReturnType<typeof snapshotDb>) {
  db.users = snapshot.users;
  db.emailTokens = snapshot.emailTokens;
  db.resetTokens = snapshot.resetTokens;
  db.categories = snapshot.categories;
  db.products = snapshot.products;
  db.variants = snapshot.variants;
  db.lists = snapshot.lists;
  db.items = snapshot.items;
  db.favorites = snapshot.favorites;
  db.variantFavorites = snapshot.variantFavorites;
  db.histories = snapshot.histories;
  db.historyItems = snapshot.historyItems;
  db.aiUsage = snapshot.aiUsage;
  db.funnelEvents = snapshot.funnelEvents;
}

function deleteUserCascade(userId: string) {
  // Mirror Prisma/Postgres cascades and SetNull semantics.
  db.users = db.users.filter((u) => u.id !== userId);
  const deletedListIds = new Set(db.lists.filter((l) => l.userId === userId).map((l) => l.id));
  db.lists = db.lists.filter((l) => l.userId !== userId);
  db.items = db.items.filter((i) => !deletedListIds.has(i.listId));
  db.favorites = db.favorites.filter((f) => f.userId !== userId);
  db.variantFavorites = db.variantFavorites.filter((vf) => vf.userId !== userId);
  const deletedHistoryIds = new Set(
    db.histories.filter((h) => h.userId === userId).map((h) => h.id)
  );
  db.histories = db.histories.filter((h) => h.userId !== userId);
  db.historyItems = db.historyItems.filter((hi) => !deletedHistoryIds.has(hi.historyId));
  db.aiUsage = db.aiUsage.filter((a) => a.userId !== userId);
  db.funnelEvents = db.funnelEvents.filter((e) => e.userId !== userId);
  // SetNull for Product.createdById on remaining products (e.g. global products).
  db.products = db.products.map((p) =>
    p.createdById === userId ? { ...p, createdById: null } : p
  );
}

vi.mock('@/lib/auth-guards', () => ({
  requireUser: doubles.requireUser,
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return {
    ...actual,
    checkRateLimit: async () => ({ allowed: true, remaining: 10, resetAt: 0 }),
  };
});

vi.mock('@/lib/prisma', () => {
  let txSeq = 0;
  const userLockTails = new Map<string, Promise<void>>();
  const activeLockOwners = new Map<string, number>();

  async function acquireUserLock(
    lockKey: string,
    txId: number | undefined,
    txReleases: Array<() => void>
  ) {
    if (txId !== undefined && activeLockOwners.get(lockKey) === txId) {
      return;
    }
    const previous = userLockTails.get(lockKey);
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const tail = (previous ?? Promise.resolve()).then(() => held);
    userLockTails.set(lockKey, tail);
    await (previous ?? Promise.resolve());
    if (txId !== undefined) {
      activeLockOwners.set(lockKey, txId);
    }
    const release = () => {
      if (txId !== undefined && activeLockOwners.get(lockKey) === txId) {
        activeLockOwners.delete(lockKey);
      }
      releaseHeld();
      if (userLockTails.get(lockKey) === tail) {
        userLockTails.delete(lockKey);
      }
    };
    if (txId !== undefined) {
      txReleases.push(release);
    } else {
      return release;
    }
  }

  function makeClient(txId?: number, txReleases: Array<() => void> = []) {
    const recordOp = (table: string, op: string) => {
      if (txId !== undefined) {
        txTrace.push({ tx: txId, table, op });
      }
    };

    const client = {
      user: {
        findUnique: async ({
          where,
          select,
        }: {
          where: { id?: string; email?: string };
          select?: Record<string, unknown>;
        }) => {
          const user = db.users.find((u) =>
            where.id ? u.id === where.id : u.email === where.email
          );
          return user ? pickSelected(user, select) : null;
        },
        update: async ({
          where,
          data,
        }: {
          where: { id?: string; email?: string };
          data: Partial<UserRow>;
        }) => {
          recordOp('users', 'update');
          const target = db.users.find((u) =>
            where.id ? u.id === where.id : u.email === where.email
          );
          const release = target ? await acquireUserLock(target.id, txId, txReleases) : undefined;
          try {
            const user = db.users.find((u) =>
              where.id ? u.id === where.id : u.email === where.email
            );
            if (!user) throw new Error('User not found');
            Object.assign(user, data, { updatedAt: new Date() });
            return user;
          } finally {
            release?.();
          }
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<UserRow>;
        }) => {
          recordOp('users', 'updateMany');
          await doubles.onBeforePasswordUpdateTx();
          const candidates = db.users.filter((u) => matches(u, where));
          const releases: Array<() => void> = [];
          for (const candidate of candidates) {
            const rel = await acquireUserLock(candidate.id, txId, txReleases);
            if (rel) releases.push(rel);
          }
          try {
            const matched = db.users.filter((u) => matches(u, where));
            for (const u of matched) {
              Object.assign(u, data, { updatedAt: new Date() });
            }
            return { count: matched.length };
          } finally {
            releases.forEach((rel) => rel());
          }
        },
        delete: async ({ where }: { where: { id: string } }) => {
          recordOp('users', 'delete');
          const release = await acquireUserLock(where.id, txId, txReleases);
          try {
            const user = db.users.find((u) => u.id === where.id);
            if (!user) throw new Error('User not found');
            deleteUserCascade(user.id);
            return user;
          } finally {
            release?.();
          }
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          recordOp('users', 'deleteMany');
          await doubles.onBeforeUserDeleteMany();
          const lockId = typeof where.id === 'string' ? where.id : undefined;
          const release = lockId ? await acquireUserLock(lockId, txId, txReleases) : undefined;
          try {
            const matched = db.users.filter((u) => matches(u, where));
            for (const u of matched) {
              deleteUserCascade(u.id);
            }
            return { count: matched.length };
          } finally {
            release?.();
          }
        },
      },
      emailVerificationToken: {
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          recordOp('emailVerificationToken', 'deleteMany');
          const before = db.emailTokens.length;
          db.emailTokens = db.emailTokens.filter((row) => !matches(row, where));
          return { count: before - db.emailTokens.length };
        },
      },
      passwordResetToken: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          recordOp('passwordResetToken', 'findFirst');
          return db.resetTokens.find((row) => matches(row, where)) ?? null;
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          recordOp('passwordResetToken', 'deleteMany');
          const before = db.resetTokens.length;
          db.resetTokens = db.resetTokens.filter((row) => !matches(row, where));
          return { count: before - db.resetTokens.length };
        },
      },
      product: {
        findMany: async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) => {
          const rows = db.products.filter((p) => matches(p, where));
          return rows.map((p) => {
            const base = pickSelected(p, select);
            if (select?.category) {
              const cat = db.categories.find((c) => c.id === p.categoryId)!;
              base.category = pickSelected(
                cat,
                (select.category as { select?: Record<string, unknown> }).select
              );
            }
            if (select?.variants) {
              const vars = db.variants.filter((v) => v.productId === p.id);
              base.variants = vars.map((v) =>
                pickSelected(v, (select.variants as { select?: Record<string, unknown> }).select)
              );
            }
            return base;
          });
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          recordOp('product', 'deleteMany');
          const toDelete = db.products.filter((p) => matches(p, where)).map((p) => p.id);
          cascadeDeleteProducts(toDelete);
          return { count: toDelete.length };
        },
      },
      list: {
        findMany: async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) => {
          const lists = db.lists.filter((l) => matches(l, where));
          return lists.map((list) => {
            const base = pickSelected(list, select);
            const itemsSpec = select?.items as
              { where?: Record<string, unknown>; select?: Record<string, unknown> } | undefined;
            if (itemsSpec) {
              const listItems = db.items.filter(
                (item) =>
                  item.listId === list.id &&
                  (!itemsSpec.where ||
                    matches(item as unknown as Record<string, unknown>, itemsSpec.where))
              );
              base.items = listItems.map((item) => {
                const itemOut = pickSelected(item, itemsSpec.select);
                if (itemsSpec.select?.product) {
                  const prod = db.products.find((p) => p.id === item.productId)!;
                  const prodSelect = (
                    itemsSpec.select.product as { select?: Record<string, unknown> }
                  ).select;
                  const prodOut = pickSelected(prod, prodSelect);
                  if (prodSelect?.category) {
                    const cat = db.categories.find((c) => c.id === prod.categoryId)!;
                    prodOut.category = pickSelected(
                      cat,
                      (prodSelect.category as { select?: Record<string, unknown> }).select
                    );
                  }
                  itemOut.product = prodOut;
                }
                if (itemsSpec.select?.variant) {
                  const variant = item.variantId
                    ? (db.variants.find((v) => v.id === item.variantId) ?? null)
                    : null;
                  itemOut.variant = variant
                    ? pickSelected(
                        variant,
                        (itemsSpec.select.variant as { select?: Record<string, unknown> }).select
                      )
                    : null;
                }
                return itemOut;
              });
            }
            return base;
          });
        },
      },
      listHistory: {
        findMany: async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) => {
          const histories = db.histories.filter((h) => matches(h, where));
          return histories.map((history) => {
            const base = pickSelected(history, select);
            const itemsSpec = select?.items as { select?: Record<string, unknown> } | undefined;
            if (itemsSpec) {
              base.items = db.historyItems
                .filter((hi) => hi.historyId === history.id)
                .map((hi) => pickSelected(hi, itemsSpec.select));
            }
            return base;
          });
        },
      },
      favorite: {
        findMany: async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) => {
          const rows = db.favorites.filter((f) => matches(f, where));
          return rows.map((fav) => {
            const base = pickSelected(fav, select);
            if (select?.product) {
              const prod = db.products.find((p) => p.id === fav.productId)!;
              const prodSelect = (select.product as { select?: Record<string, unknown> }).select;
              const prodOut = pickSelected(prod, prodSelect);
              if (prodSelect?.category) {
                const cat = db.categories.find((c) => c.id === prod.categoryId)!;
                prodOut.category = pickSelected(
                  cat,
                  (prodSelect.category as { select?: Record<string, unknown> }).select
                );
              }
              base.product = prodOut;
            }
            return base;
          });
        },
      },
      variantFavorite: {
        findMany: async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) => {
          const rows = db.variantFavorites.filter((vf) => matches(vf, where));
          return rows.map((vf) => {
            const base = pickSelected(vf, select);
            if (select?.variant) {
              const variant = db.variants.find((v) => v.id === vf.variantId)!;
              const varSelect = (select.variant as { select?: Record<string, unknown> }).select;
              const varOut = pickSelected(variant, varSelect);
              if (varSelect?.product) {
                const prod = db.products.find((p) => p.id === variant.productId)!;
                const prodSelect = (varSelect.product as { select?: Record<string, unknown> })
                  .select;
                const prodOut = pickSelected(prod, prodSelect);
                if (prodSelect?.category) {
                  const cat = db.categories.find((c) => c.id === prod.categoryId)!;
                  prodOut.category = pickSelected(
                    cat,
                    (prodSelect.category as { select?: Record<string, unknown> }).select
                  );
                }
                varOut.product = prodOut;
              }
              base.variant = varOut;
            }
            return base;
          });
        },
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (/FROM\s+users\s+WHERE\s+id\s*=\s*\?\s+FOR\s+UPDATE/i.test(sql)) {
          recordOp('users', 'forUpdate');
          await doubles.onBeforeDeleteLock();
          const userId = String(values[0]);
          await acquireUserLock(userId, txId, txReleases);
          await doubles.onAfterDeleteLock();
          const user = db.users.find((u) => u.id === userId);
          return user ? [{ id: user.id, email: user.email, password: user.password }] : [];
        }
        if (/FROM\s+users\s+WHERE\s+email\s*=\s*\?\s+FOR\s+UPDATE/i.test(sql)) {
          recordOp('users', 'forUpdate');
          const email = String(values[0]);
          const candidate = db.users.find((u) => u.email === email);
          await acquireUserLock(candidate?.id ?? `email:${email}`, txId, txReleases);
          await doubles.onAfterResetLock();
          const user = db.users.find((u) => u.email === email);
          return user ? [{ id: user.id, emailVerified: user.emailVerified }] : [];
        }
        throw new Error(`Unsupported $queryRaw in test fake: ${sql}`);
      },
      $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
        const nextTxId = ++txSeq;
        const snapshot = snapshotDb();
        const releases: Array<() => void> = [];
        try {
          const result = await run(makeClient(nextTxId, releases));
          return result;
        } catch (error) {
          restoreDb(snapshot);
          throw error;
        } finally {
          releases.forEach((release) => release());
        }
      },
    };
    return client;
  }

  return { prisma: makeClient() };
});

const accountRoute = await import('@/app/api/account/route');
const passwordRoute = await import('@/app/api/account/password/route');
const exportRoute = await import('@/app/api/account/export/route');
const resetPasswordRoute = await import('@/app/api/auth/reset-password/route');

function jsonRequest(url: string, method: string, body?: unknown, locale: 'ru' | 'en' = 'ru') {
  return new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: `NEXT_LOCALE=${locale}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedDatabase() {
  const now = new Date('2026-11-20T10:00:00.000Z');
  const passwordHashA = await bcrypt.hash('Password123', 4);
  const passwordHashB = await bcrypt.hash('OtherPass456', 4);

  db.users = [
    {
      id: 'user-a',
      email: 'alice@example.com',
      name: 'Alice',
      password: passwordHashA,
      image: null,
      role: 'ADMIN',
      emailVerified: now,
      createdProductsCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'user-b',
      email: 'bob@example.com',
      name: 'Bob',
      password: passwordHashB,
      image: null,
      role: 'USER',
      emailVerified: now,
      createdProductsCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'user-google',
      email: 'google@example.com',
      name: 'Google User',
      password: null,
      image: null,
      role: 'USER',
      emailVerified: now,
      createdProductsCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  ];

  db.emailTokens = [
    {
      id: 'et-a',
      email: 'alice@example.com',
      token: 'secret-verify-a',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
    },
    {
      id: 'et-b',
      email: 'bob@example.com',
      token: 'secret-verify-b',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
    },
  ];

  // SHA-256 of 'raw-reset-token-a'
  const crypto = await import('node:crypto');
  const hashedResetA = crypto.createHash('sha256').update('raw-reset-token-a').digest('hex');
  db.resetTokens = [
    {
      id: 'rt-a',
      email: 'alice@example.com',
      token: hashedResetA,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
    },
    {
      id: 'rt-b',
      email: 'bob@example.com',
      token: 'secret-reset-b',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
    },
  ];

  db.categories = [{ id: 'cat-1', name: 'Молочные продукты', nameEn: 'Dairy', emoji: '🥛' }];

  db.products = [
    {
      id: 'prod-global-by-a',
      name: 'Молоко',
      nameEn: 'Milk',
      emoji: '🥛',
      isCustom: false,
      imageUrl: null,
      imageUrlEn: null,
      categoryId: 'cat-1',
      isGlobal: true,
      createdById: 'user-a',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'prod-private-a',
      name: 'Секрет Алисы',
      nameEn: 'Alice Secret',
      emoji: '🧀',
      isCustom: false,
      imageUrl: null,
      imageUrlEn: null,
      categoryId: 'cat-1',
      isGlobal: false,
      createdById: 'user-a',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'prod-private-b',
      name: 'Секрет Боба',
      nameEn: 'Bob Secret',
      emoji: '🍞',
      isCustom: false,
      imageUrl: null,
      imageUrlEn: null,
      categoryId: 'cat-1',
      isGlobal: false,
      createdById: 'user-b',
      createdAt: now,
      updatedAt: now,
    },
  ];

  db.variants = [
    {
      id: 'var-global',
      name: '3.2%',
      nameEn: 'Whole',
      emoji: '🥛',
      imageUrl: null,
      imageUrlEn: null,
      productId: 'prod-global-by-a',
    },
  ];

  db.lists = [
    {
      id: 'list-a',
      name: 'Список Алисы',
      isActive: true,
      userId: 'user-a',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'list-b',
      name: 'Список Боба',
      isActive: true,
      userId: 'user-b',
      createdAt: now,
      updatedAt: now,
    },
  ];

  db.items = [
    {
      id: 'item-a-global',
      listId: 'list-a',
      productId: 'prod-global-by-a',
      variantId: 'var-global',
      isPurchased: false,
      note: '2л',
      createdAt: now,
      updatedAt: now,
      purchasedAt: null,
    },
    {
      id: 'item-a-own',
      listId: 'list-a',
      productId: 'prod-private-a',
      variantId: null,
      isPurchased: false,
      note: null,
      createdAt: now,
      updatedAt: now,
      purchasedAt: null,
    },
    // Legacy item pointing to Bob's private product must never leak into Alice's export.
    {
      id: 'item-a-legacy-foreign',
      listId: 'list-a',
      productId: 'prod-private-b',
      variantId: null,
      isPurchased: false,
      note: null,
      createdAt: now,
      updatedAt: now,
      purchasedAt: null,
    },
    {
      id: 'item-b-global',
      listId: 'list-b',
      productId: 'prod-global-by-a',
      variantId: 'var-global',
      isPurchased: false,
      note: 'для кофе',
      createdAt: now,
      updatedAt: now,
      purchasedAt: null,
    },
    {
      id: 'item-b-own',
      listId: 'list-b',
      productId: 'prod-private-b',
      variantId: null,
      isPurchased: true,
      note: null,
      createdAt: now,
      updatedAt: now,
      purchasedAt: now,
    },
  ];

  db.favorites = [
    {
      id: 'fav-a',
      userId: 'user-a',
      productId: 'prod-private-a',
      usageCount: 3,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'fav-a-legacy',
      userId: 'user-a',
      productId: 'prod-private-b',
      usageCount: 99,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'fav-b',
      userId: 'user-b',
      productId: 'prod-global-by-a',
      usageCount: 2,
      createdAt: now,
      updatedAt: now,
    },
  ];

  db.variantFavorites = [
    {
      id: 'vfav-a',
      userId: 'user-a',
      variantId: 'var-global',
      usageCount: 5,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'vfav-b',
      userId: 'user-b',
      variantId: 'var-global',
      usageCount: 4,
      createdAt: now,
      updatedAt: now,
    },
  ];

  db.histories = [
    {
      id: 'hist-a',
      userId: 'user-a',
      listId: 'list-a',
      listName: 'История Алисы',
      completedAt: now,
      createdAt: now,
    },
    {
      id: 'hist-b',
      userId: 'user-b',
      listId: 'list-b',
      listName: 'История Боба',
      completedAt: now,
      createdAt: now,
    },
  ];

  db.historyItems = [
    {
      id: 'hi-a-own',
      historyId: 'hist-a',
      productId: 'prod-private-a',
      variantId: null,
      productName: 'Секрет Алисы',
      productNameEn: 'Alice Secret',
      productEmoji: '🧀',
      productImageUrl: null,
      productImageUrlEn: null,
      categoryName: 'Молочные продукты',
      categoryNameEn: 'Dairy',
      isCustom: false,
      variantName: null,
      variantNameEn: null,
      variantEmoji: null,
      note: null,
      isPurchased: true,
      addedAt: now,
      createdAt: now,
    },
    {
      id: 'hi-a-legacy-foreign',
      historyId: 'hist-a',
      productId: 'prod-private-b',
      variantId: null,
      productName: 'Секрет Боба',
      productNameEn: 'Bob Secret',
      productEmoji: '🍞',
      productImageUrl: null,
      productImageUrlEn: null,
      categoryName: 'Молочные продукты',
      categoryNameEn: 'Dairy',
      isCustom: false,
      variantName: null,
      variantNameEn: null,
      variantEmoji: null,
      note: null,
      isPurchased: true,
      addedAt: now,
      createdAt: now,
    },
    {
      id: 'hi-b-global',
      historyId: 'hist-b',
      productId: 'prod-global-by-a',
      variantId: 'var-global',
      productName: 'Молоко',
      productNameEn: 'Milk',
      productEmoji: '🥛',
      productImageUrl: null,
      productImageUrlEn: null,
      categoryName: 'Молочные продукты',
      categoryNameEn: 'Dairy',
      isCustom: false,
      variantName: '3.2%',
      variantNameEn: 'Whole',
      variantEmoji: '🥛',
      note: null,
      isPurchased: true,
      addedAt: now,
      createdAt: now,
    },
  ];

  db.aiUsage = [{ userId: 'user-a' }, { userId: 'user-b' }];
  db.funnelEvents = [
    { id: 'fe-a', userId: 'user-a' },
    { id: 'fe-b', userId: 'user-b' },
  ];
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  doubles.onBeforePasswordUpdateTx.mockImplementation(() => undefined);
  doubles.onBeforeDeleteLock.mockImplementation(() => undefined);
  doubles.onAfterDeleteLock.mockImplementation(() => undefined);
  doubles.onAfterResetLock.mockImplementation(() => undefined);
  doubles.onBeforeUserDeleteMany.mockImplementation(() => undefined);
  txTrace.length = 0;
  await seedDatabase();
  doubles.requireUser.mockResolvedValue({
    session: { user: { id: 'user-a', email: 'alice@example.com', role: 'ADMIN' } },
  });
});

describe('Account authentication boundary', () => {
  it('returns 401 when unauthenticated across all account endpoints', async () => {
    const unauthorized = Response.json({ error: 'Unauthorized' }, { status: 401 });
    doubles.requireUser.mockResolvedValue(unauthorized);

    expect(
      (await accountRoute.GET(jsonRequest('http://localhost/api/account', 'GET'))).status
    ).toBe(401);
    expect(
      (
        await passwordRoute.POST(
          jsonRequest('http://localhost/api/account/password', 'POST', {
            currentPassword: 'Password123',
            newPassword: 'NewPassword123',
          })
        )
      ).status
    ).toBe(401);
    expect(
      (await exportRoute.GET(jsonRequest('http://localhost/api/account/export', 'GET'))).status
    ).toBe(401);
    expect(
      (
        await accountRoute.DELETE(
          jsonRequest('http://localhost/api/account', 'DELETE', { password: 'Password123' })
        )
      ).status
    ).toBe(401);
  });

  it('never leaks password hash in GET /api/account', async () => {
    const res = await accountRoute.GET(jsonRequest('http://localhost/api/account', 'GET'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.user.hasPassword).toBe(true);
    expect(body.user.password).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(db.users[0].password!);
  });
});

describe('POST /api/account/password', () => {
  it('updates password when current password matches and invalidates pending reset tokens', async () => {
    const res = await passwordRoute.POST(
      jsonRequest(
        'http://localhost/api/account/password',
        'POST',
        { currentPassword: 'Password123', newPassword: 'NewPassword456' },
        'en'
      )
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe('Password updated');
    const updatedAlice = db.users.find((u) => u.id === 'user-a')!;
    expect(await bcrypt.compare('NewPassword456', updatedAlice.password!)).toBe(true);
    expect(await bcrypt.compare('Password123', updatedAlice.password!)).toBe(false);
    // Alice's pending reset token must be invalidated; Bob's stays intact.
    expect(db.resetTokens.map((t) => t.email)).toEqual(['bob@example.com']);
  });

  it('rejects wrong current password without modifying hash or reset tokens', async () => {
    const beforeHash = db.users[0].password;
    const res = await passwordRoute.POST(
      jsonRequest(
        'http://localhost/api/account/password',
        'POST',
        { currentPassword: 'WrongPassword1', newPassword: 'NewPassword456' },
        'ru'
      )
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Неверный текущий пароль' });
    expect(db.users[0].password).toBe(beforeHash);
    expect(db.resetTokens.map((t) => t.email)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('rejects passwordless Google users with localized explanation', async () => {
    doubles.requireUser.mockResolvedValue({
      session: { user: { id: 'user-google', email: 'google@example.com', role: 'USER' } },
    });

    const res = await passwordRoute.POST(
      jsonRequest(
        'http://localhost/api/account/password',
        'POST',
        { currentPassword: 'Password123', newPassword: 'NewPassword456' },
        'en'
      )
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('NO_LOCAL_PASSWORD');
    expect(body.error).toContain('Google');
  });

  it('detects concurrent password change (e.g. password reset) with 409 Conflict', async () => {
    const resetHash = await bcrypt.hash('ResetWinner99', 4);
    doubles.onBeforePasswordUpdateTx.mockImplementationOnce(() => {
      db.users[0].password = resetHash;
    });

    const res = await passwordRoute.POST(
      jsonRequest(
        'http://localhost/api/account/password',
        'POST',
        { currentPassword: 'Password123', newPassword: 'NewPassword456' },
        'en'
      )
    );

    expect(res.status).toBe(409);
    expect(db.users[0].password).toBe(resetHash);
  });

  it('allows only one concurrent password-reset request to consume a reset token', async () => {
    const [res1, res2] = await Promise.all([
      resetPasswordRoute.POST(
        jsonRequest(
          'http://localhost/api/auth/reset-password',
          'POST',
          { email: 'alice@example.com', token: 'raw-reset-token-a', password: 'ResetPassword1' },
          'en'
        )
      ),
      resetPasswordRoute.POST(
        jsonRequest(
          'http://localhost/api/auth/reset-password',
          'POST',
          { email: 'alice@example.com', token: 'raw-reset-token-a', password: 'ResetPassword2' },
          'en'
        )
      ),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 400]);
  });
});

describe('GET /api/account/export', () => {
  it('exports only the authenticated user data without foreign rows, password hashes, or tokens', async () => {
    // Even if caller passes a foreign userId query param, server ignores it.
    const res = await exportRoute.GET(
      jsonRequest('http://localhost/api/account/export?userId=user-b', 'GET', undefined, 'en')
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('content-disposition')).toContain('clickmoji-account-export.json');

    const rawText = await res.text();
    const payload = JSON.parse(rawText);

    expect(payload.profile.id).toBe('user-a');
    expect(payload.profile.email).toBe('alice@example.com');
    expect(payload.profile.password).toBeUndefined();

    // Lists & items: excludes legacy item referencing Bob's private product.
    expect(payload.lists).toHaveLength(1);
    expect(payload.lists[0].id).toBe('list-a');
    expect(payload.lists[0].items.map((i: { product: { id: string } }) => i.product.id)).toEqual([
      'prod-global-by-a',
      'prod-private-a',
    ]);

    // History: excludes legacy snapshot item referencing Bob's private product.
    expect(payload.history).toHaveLength(1);
    expect(payload.history[0].items.map((i: { productId: string }) => i.productId)).toEqual([
      'prod-private-a',
    ]);

    // Favorites: excludes Bob's private product favorite.
    expect(payload.favorites.map((f: { product: { id: string } }) => f.product.id)).toEqual([
      'prod-global-by-a',
      'prod-private-a',
    ]);

    // Created products: Alice's global and private products.
    expect(payload.createdProducts.map((p: { id: string }) => p.id)).toEqual([
      'prod-global-by-a',
      'prod-private-a',
    ]);

    // No secrets, no tokens, no Bob's data anywhere in the serialized JSON.
    for (const forbidden of [
      db.users[0].password!,
      db.users[1].password!,
      'bob@example.com',
      'user-b',
      'prod-private-b',
      'Секрет Боба',
      'Список Боба',
      'История Боба',
      'secret-verify-a',
      'secret-verify-b',
      'secret-reset-b',
      db.resetTokens[0].token,
    ]) {
      expect(rawText).not.toContain(forbidden);
    }
  });

  it('preserves own history snapshots after product deletion (productId=null via SetNull) without leaking foreign private products', async () => {
    // Simulate a global/own catalog product that was deleted earlier (SetNull nulled productId/variantId
    // while keeping snapshot columns) alongside Alice's product deletion via cascadeDeleteProducts,
    // while hi-a-legacy-foreign still points to Bob's existing private product.
    const now = new Date('2026-11-20T10:00:00.000Z');
    db.historyItems.push({
      id: 'hi-a-deleted-catalog',
      historyId: 'hist-a',
      productId: null,
      variantId: null,
      productName: 'Удалённый товар',
      productNameEn: 'Deleted Product',
      productEmoji: '🥫',
      productImageUrl: null,
      productImageUrlEn: null,
      categoryName: 'Бакалея',
      categoryNameEn: 'Pantry',
      isCustom: false,
      variantName: 'Большая банка',
      variantNameEn: 'Large jar',
      variantEmoji: '🥫',
      note: '2 шт',
      isPurchased: true,
      addedAt: now,
      createdAt: now,
    });
    // Also delete Alice's own private product (onDelete: SetNull on ListHistoryItem.productId).
    cascadeDeleteProducts(['prod-private-a']);

    const res = await exportRoute.GET(
      jsonRequest('http://localhost/api/account/export', 'GET', undefined, 'en')
    );
    expect(res.status).toBe(200);

    const rawText = await res.text();
    const payload = JSON.parse(rawText);

    // Boundary 1: Both SetNull own history snapshots (productId === null) are preserved in full.
    expect(payload.history).toHaveLength(1);
    expect(payload.history[0].items).toHaveLength(2);
    expect(payload.history[0].items.map((item: { id: string }) => item.id)).toEqual([
      'hi-a-own',
      'hi-a-deleted-catalog',
    ]);
    expect(payload.history[0].items[0]).toMatchObject({
      id: 'hi-a-own',
      productId: null,
      variantId: null,
      productName: 'Секрет Алисы',
      productNameEn: 'Alice Secret',
    });
    expect(payload.history[0].items[1]).toMatchObject({
      id: 'hi-a-deleted-catalog',
      productId: null,
      variantId: null,
      productName: 'Удалённый товар',
      productNameEn: 'Deleted Product',
      variantName: 'Большая банка',
      note: '2 шт',
    });

    // Boundary 2: Foreign private product snapshot (hi-a-legacy-foreign) remains excluded.
    expect(rawText).not.toContain('hi-a-legacy-foreign');
    expect(rawText).not.toContain('prod-private-b');
    expect(rawText).not.toContain('Секрет Боба');
    expect(rawText).not.toContain('Bob Secret');
  });
});

describe('DELETE /api/account', () => {
  it('rejects wrong password without deleting any records', async () => {
    const res = await accountRoute.DELETE(
      jsonRequest('http://localhost/api/account', 'DELETE', { password: 'WrongPassword1' }, 'en')
    );

    expect(res.status).toBe(400);
    expect(db.users.map((u) => u.id)).toContain('user-a');
    expect(db.lists.map((l) => l.id)).toContain('list-a');
  });

  it('deletes user data, tokens, and private products transactionally while preserving other users and SetNull global products', async () => {
    const res = await accountRoute.DELETE(
      jsonRequest('http://localhost/api/account', 'DELETE', { password: 'Password123' }, 'ru')
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: 'Аккаунт удалён' });

    // Alice and all her owned data/tokens/private products are gone.
    expect(db.users.map((u) => u.id)).toEqual(['user-b', 'user-google']);
    expect(db.emailTokens.map((t) => t.email)).toEqual(['bob@example.com']);
    expect(db.resetTokens.map((t) => t.email)).toEqual(['bob@example.com']);
    expect(db.lists.map((l) => l.userId)).toEqual(['user-b']);
    expect(db.histories.map((h) => h.userId)).toEqual(['user-b']);
    expect(db.favorites.map((f) => f.userId)).toEqual(['user-b']);
    expect(db.variantFavorites.map((vf) => vf.userId)).toEqual(['user-b']);
    expect(db.aiUsage.map((a) => a.userId)).toEqual(['user-b']);
    expect(db.funnelEvents.map((e) => e.userId)).toEqual(['user-b']);

    // Alice's private product is deleted, while global product created by Alice stays with createdById=null (SetNull).
    expect(db.products.map((p) => p.id)).toEqual(['prod-global-by-a', 'prod-private-b']);
    const globalProd = db.products.find((p) => p.id === 'prod-global-by-a')!;
    expect(globalProd.isGlobal).toBe(true);
    expect(globalProd.createdById).toBeNull();

    // Bob's items, favorites, variant favorites, and history referencing that global product remain intact!
    expect(db.items.map((i) => i.id)).toEqual(['item-b-global', 'item-b-own']);
    expect(db.favorites.map((f) => f.id)).toEqual(['fav-b']);
    expect(db.variantFavorites.map((vf) => vf.id)).toEqual(['vfav-b']);
    expect(db.historyItems.map((hi) => hi.id)).toEqual(['hi-b-global']);
  });

  it('requires confirmation phrase for passwordless Google users and deletes on match', async () => {
    doubles.requireUser.mockResolvedValue({
      session: { user: { id: 'user-google', email: 'google@example.com', role: 'USER' } },
    });

    const bad = await accountRoute.DELETE(
      jsonRequest('http://localhost/api/account', 'DELETE', { confirmation: 'nope' }, 'en')
    );
    expect(bad.status).toBe(400);
    expect(db.users.map((u) => u.id)).toContain('user-google');

    const ok = await accountRoute.DELETE(
      jsonRequest('http://localhost/api/account', 'DELETE', { confirmation: 'DELETE' }, 'en')
    );
    expect(ok.status).toBe(200);
    expect(db.users.map((u) => u.id)).not.toContain('user-google');
  });

  it('returns 409 and leaves user and data intact when password changes before delete transaction locks row', async () => {
    const newHash = await bcrypt.hash('ConcurrentReset1', 4);
    doubles.onBeforeDeleteLock.mockImplementationOnce(() => {
      db.users[0].password = newHash;
    });

    const res = await accountRoute.DELETE(
      jsonRequest('http://localhost/api/account', 'DELETE', { password: 'Password123' }, 'en')
    );

    expect(res.status).toBe(409);
    expect(db.users.find((u) => u.id === 'user-a')?.password).toBe(newHash);
    expect(db.emailTokens.map((t) => t.email)).toEqual(['alice@example.com', 'bob@example.com']);
    expect(db.resetTokens.map((t) => t.email)).toEqual(['alice@example.com', 'bob@example.com']);
    expect(db.products.map((p) => p.id)).toContain('prod-private-a');
    expect(db.lists.map((l) => l.id)).toContain('list-a');
  });

  it('rolls back deleted tokens and private products when user.deleteMany CAS sees concurrent password change', async () => {
    const originalHash = db.users[0].password;
    const newHash = await bcrypt.hash('MidTxChange1', 4);
    doubles.onBeforeUserDeleteMany.mockImplementationOnce(() => {
      db.users[0].password = newHash;
    });

    const res = await accountRoute.DELETE(
      jsonRequest('http://localhost/api/account', 'DELETE', { password: 'Password123' }, 'en')
    );

    expect(res.status).toBe(409);
    // All deletions performed earlier inside the transaction must be rolled back.
    expect(db.users.find((u) => u.id === 'user-a')?.password).toBe(originalHash);
    expect(db.emailTokens.map((t) => t.id)).toEqual(['et-a', 'et-b']);
    expect(db.resetTokens.map((t) => t.id)).toEqual(['rt-a', 'rt-b']);
    expect(db.products.map((p) => p.id)).toEqual([
      'prod-global-by-a',
      'prod-private-a',
      'prod-private-b',
    ]);
    expect(db.lists.map((l) => l.id)).toEqual(['list-a', 'list-b']);
    expect(db.histories.map((h) => h.id)).toEqual(['hist-a', 'hist-b']);
  });

  it('returns 409 for passwordless Google user if a password is set concurrently before deletion', async () => {
    doubles.requireUser.mockResolvedValue({
      session: { user: { id: 'user-google', email: 'google@example.com', role: 'USER' } },
    });
    const setHash = await bcrypt.hash('NewResetPass1', 4);
    doubles.onBeforeDeleteLock.mockImplementationOnce(() => {
      db.users.find((u) => u.id === 'user-google')!.password = setHash;
    });

    const res = await accountRoute.DELETE(
      jsonRequest('http://localhost/api/account', 'DELETE', { confirmation: 'DELETE' }, 'en')
    );

    expect(res.status).toBe(409);
    expect(db.users.find((u) => u.id === 'user-google')?.password).toBe(setHash);
  });

  it('serializes concurrent deleteAccount and reset-password when delete locks user first without deadlock or 500', async () => {
    let resetPromise: Promise<Response> | undefined;
    doubles.onAfterDeleteLock.mockImplementationOnce(() => {
      resetPromise = resetPasswordRoute.POST(
        jsonRequest(
          'http://localhost/api/auth/reset-password',
          'POST',
          { email: 'alice@example.com', token: 'raw-reset-token-a', password: 'ResetWinner1' },
          'en'
        )
      );
    });

    const deleteRes = await accountRoute.DELETE(
      jsonRequest('http://localhost/api/account', 'DELETE', { password: 'Password123' }, 'en')
    );
    const resetRes = await resetPromise!;

    expect(deleteRes.status).toBe(200);
    expect(resetRes.status).toBe(400);
    expect(db.users.find((u) => u.id === 'user-a')).toBeUndefined();
    expect(db.resetTokens.map((t) => t.email)).toEqual(['bob@example.com']);
  });

  it('serializes concurrent reset-password and deleteAccount when reset locks user first and rejects delete with 409', async () => {
    let deletePromise: Promise<Response> | undefined;
    let releaseReset!: () => void;
    const resetCanContinue = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });

    doubles.onBeforeDeleteLock.mockImplementationOnce(() => {
      releaseReset();
    });
    doubles.onAfterResetLock.mockImplementationOnce(async () => {
      // Launch deleteAccount while reset-password holds the user lock and before it updates the
      // password hash, then wait until deleteAccount has passed bcrypt.compare and reached its lock.
      deletePromise = accountRoute.DELETE(
        jsonRequest('http://localhost/api/account', 'DELETE', { password: 'Password123' }, 'en')
      );
      await resetCanContinue;
    });

    const resetRes = await resetPasswordRoute.POST(
      jsonRequest(
        'http://localhost/api/auth/reset-password',
        'POST',
        { email: 'alice@example.com', token: 'raw-reset-token-a', password: 'ResetWinner1' },
        'en'
      )
    );
    const deleteRes = await deletePromise!;

    expect(resetRes.status).toBe(200);
    expect(deleteRes.status).toBe(409);
    const alice = db.users.find((u) => u.id === 'user-a')!;
    expect(alice).toBeDefined();
    expect(await bcrypt.compare('ResetWinner1', alice.password!)).toBe(true);
    expect(db.products.map((p) => p.id)).toContain('prod-private-a');
    expect(db.lists.map((l) => l.id)).toContain('list-a');
  });

  it('acquires users lock before passwordResetToken across password change, reset-password, and deleteAccount', async () => {
    await passwordRoute.POST(
      jsonRequest(
        'http://localhost/api/account/password',
        'POST',
        { currentPassword: 'Password123', newPassword: 'NewPassword456' },
        'en'
      )
    );
    await seedDatabase();
    await resetPasswordRoute.POST(
      jsonRequest(
        'http://localhost/api/auth/reset-password',
        'POST',
        { email: 'alice@example.com', token: 'raw-reset-token-a', password: 'ResetPassword1' },
        'en'
      )
    );
    await seedDatabase();
    await accountRoute.DELETE(
      jsonRequest('http://localhost/api/account', 'DELETE', { password: 'Password123' }, 'en')
    );

    const tablesByTx = new Map<number, string[]>();
    for (const entry of txTrace) {
      const list = tablesByTx.get(entry.tx) ?? [];
      list.push(entry.table);
      tablesByTx.set(entry.tx, list);
    }

    expect(tablesByTx.size).toBe(3);
    for (const tables of tablesByTx.values()) {
      expect(tables[0]).toBe('users');
      const tokenIdx = tables.indexOf('passwordResetToken');
      expect(tokenIdx).toBeGreaterThan(0);
    }
  });
});
