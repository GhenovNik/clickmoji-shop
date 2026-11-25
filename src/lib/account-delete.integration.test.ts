// @vitest-environment node
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from './prisma-adapter';
import type { deleteAccount as DeleteAccountFn } from './account';

// Run only through npm run test:account-delete-postgres: it creates and removes its own Docker DB.
const url = process.env.INTEGRATION_DATABASE_URL;

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!url)('account deletion guards on disposable PostgreSQL', () => {
  let db: PrismaClient;
  let writer: PrismaClient;
  let deleteAccount: typeof DeleteAccountFn;
  const password = 'Password123';

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/account_delete_test') {
      throw new Error('This destructive fixture requires the Docker test runner database');
    }
    // The app's shared Prisma client reads DATABASE_URL, so it must point at the same disposable DB.
    if (process.env.DATABASE_URL !== url) {
      throw new Error('DATABASE_URL must equal INTEGRATION_DATABASE_URL for this fixture');
    }
    db = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
    writer = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
    ({ deleteAccount } = await import('./account'));
  });

  afterAll(async () => {
    await Promise.all([db?.$disconnect(), writer?.$disconnect()]);
  });

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE users, categories, email_verification_tokens, password_reset_tokens CASCADE`;
    const hash = await bcrypt.hash(password, 4);
    await db.user.create({ data: { id: 'alice', email: 'alice@example.test', password: hash } });
    await db.user.create({ data: { id: 'bob', email: 'bob@example.test', password: hash } });
    await db.emailVerificationToken.create({
      data: {
        email: 'alice@example.test',
        token: 'alice-verify',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await db.passwordResetToken.create({
      data: {
        email: 'alice@example.test',
        token: 'alice-reset',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await db.category.create({
      data: { id: 'fruit', name: 'Фрукты', nameEn: 'Fruit', emoji: '🍎', order: 1 },
    });
    // Alice's global product (she is only the author) and her private product with a variant.
    await db.product.create({
      data: {
        id: 'milk-global',
        name: 'Молоко',
        nameEn: 'Milk',
        emoji: '🥛',
        categoryId: 'fruit',
        isGlobal: true,
        createdById: 'alice',
      },
    });
    await db.productVariant.create({
      data: {
        id: 'milk-variant',
        name: '3.2%',
        nameEn: 'Whole',
        emoji: '🥛',
        productId: 'milk-global',
      },
    });
    await db.product.create({
      data: {
        id: 'alice-private',
        name: 'Секрет Алисы',
        nameEn: 'Alice Secret',
        emoji: '🧀',
        categoryId: 'fruit',
        isGlobal: false,
        createdById: 'alice',
      },
    });
    await db.productVariant.create({
      data: {
        id: 'alice-variant',
        name: 'Ханикрисп',
        nameEn: 'Honeycrisp',
        emoji: '🍎',
        productId: 'alice-private',
      },
    });
    await db.list.create({ data: { id: 'alice-list', name: 'Список Алисы', userId: 'alice' } });
    await db.list.create({ data: { id: 'bob-list', name: 'Список Боба', userId: 'bob' } });
  });

  // Every row that a deletion could touch, compared by value: a refused deletion must leave all of it.
  async function stateOf() {
    const byId = { orderBy: { id: 'asc' as const } };
    const [users, emailTokens, resetTokens, products, variants, lists, items, favorites] =
      await Promise.all([
        db.user.findMany(byId),
        db.emailVerificationToken.findMany(byId),
        db.passwordResetToken.findMany(byId),
        db.product.findMany(byId),
        db.productVariant.findMany(byId),
        db.list.findMany(byId),
        db.item.findMany(byId),
        db.favorite.findMany(byId),
      ]);
    const [variantFavorites, histories, historyItems] = await Promise.all([
      db.variantFavorite.findMany(byId),
      db.listHistory.findMany(byId),
      db.listHistoryItem.findMany(byId),
    ]);
    return {
      users,
      emailTokens,
      resetTokens,
      products,
      variants,
      lists,
      items,
      favorites,
      variantFavorites,
      histories,
      historyItems,
    };
  }

  describe('cross-owner references to the deleted account', () => {
    it('refuses with 409 status and keeps every row when another list item points at a private product', async () => {
      await db.item.create({ data: { listId: 'bob-list', productId: 'alice-private' } });
      const before = await stateOf();

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'cross_owner_references' });
      expect(await stateOf()).toEqual(before);
    });

    it('refuses when another list item keeps a variant of a private product on a global product (independent variant FK)', async () => {
      await db.item.create({
        data: { listId: 'bob-list', productId: 'milk-global', variantId: 'alice-variant' },
      });
      const before = await stateOf();

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'cross_owner_references' });
      expect(await stateOf()).toEqual(before);
    });

    it('refuses when another user favorited a private product', async () => {
      await db.favorite.create({ data: { userId: 'bob', productId: 'alice-private' } });
      const before = await stateOf();

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'cross_owner_references' });
      expect(await stateOf()).toEqual(before);
    });

    it('refuses when another user starred a variant of a private product', async () => {
      await db.variantFavorite.create({ data: { userId: 'bob', variantId: 'alice-variant' } });
      const before = await stateOf();

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'cross_owner_references' });
      expect(await stateOf()).toEqual(before);
    });

    it('refuses when another user history snapshot would be SetNull-ed through productId', async () => {
      await db.listHistory.create({
        data: { id: 'bob-history', userId: 'bob', listName: 'История Боба' },
      });
      await db.listHistoryItem.create({
        data: {
          historyId: 'bob-history',
          productId: 'alice-private',
          productName: 'Секрет Алисы',
          productEmoji: '🧀',
          categoryName: 'Фрукты',
          addedAt: new Date(),
        },
      });
      const before = await stateOf();

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'cross_owner_references' });
      expect(await stateOf()).toEqual(before);
    });

    it('refuses when another user history snapshot would be SetNull-ed through a private variant', async () => {
      await db.listHistory.create({
        data: { id: 'bob-history', userId: 'bob', listName: 'История Боба' },
      });
      await db.listHistoryItem.create({
        data: {
          historyId: 'bob-history',
          productId: 'milk-global',
          variantId: 'alice-variant',
          productName: 'Молоко',
          productEmoji: '🥛',
          categoryName: 'Фрукты',
          variantName: 'Ханикрисп',
          addedAt: new Date(),
        },
      });
      const before = await stateOf();

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'cross_owner_references' });
      expect(await stateOf()).toEqual(before);
    });

    it('refuses when another user history points at a list of the deleted account (ListHistory.listId SetNull)', async () => {
      await db.listHistory.create({
        data: { id: 'bob-history', userId: 'bob', listId: 'alice-list', listName: 'История Боба' },
      });
      const before = await stateOf();

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'cross_owner_references' });
      expect(await stateOf()).toEqual(before);
    });

    it('waits for an uncommitted concurrent reference to the private product, then refuses with the committed reference', async () => {
      const inserted = barrier();
      const release = barrier();
      const writing = writer.$transaction(async (tx) => {
        await tx.item.create({ data: { listId: 'bob-list', productId: 'alice-private' } });
        inserted.resolve();
        await release.promise;
      });
      await inserted.promise;
      // Uncommitted from every other connection's point of view: the list has no Bob item yet.
      const { items: itemsBefore, ...rowsBefore } = await stateOf();
      expect(itemsBefore).toEqual([]);

      // The deletion must block on the row lock taken by the uncommitted FK insert, not read past it.
      const deleting = deleteAccount({ userId: 'alice', password });
      const stillBlocked = await Promise.race([
        deleting.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 500)),
      ]);
      expect(stillBlocked).toBe(true);

      release.resolve();
      await writing;

      expect(await deleting).toEqual({ status: 'cross_owner_references' });
      // Refusal rolls back: only the committed concurrent reference is new, nothing else changed.
      const { items, ...rowsAfter } = await stateOf();
      expect(rowsAfter).toEqual(rowsBefore);
      expect(items.map((i) => [i.listId, i.productId])).toEqual([['bob-list', 'alice-private']]);
    });
  });

  describe('successful deletion with cross-owner data present', () => {
    it('removes private data, clears global product authorship and keeps other users rows intact', async () => {
      await db.product.create({
        data: {
          id: 'bob-private',
          name: 'Секрет Боба',
          nameEn: 'Bob Secret',
          emoji: '🍞',
          categoryId: 'fruit',
          isGlobal: false,
          createdById: 'bob',
        },
      });
      // Bob's references to Alice's global product and his own private product must survive.
      await db.item.create({
        data: { listId: 'bob-list', productId: 'milk-global', variantId: 'milk-variant' },
      });
      await db.item.create({ data: { listId: 'bob-list', productId: 'bob-private' } });
      await db.favorite.create({ data: { userId: 'bob', productId: 'milk-global' } });
      await db.variantFavorite.create({ data: { userId: 'bob', variantId: 'milk-variant' } });
      await db.listHistory.create({
        data: { id: 'bob-history', userId: 'bob', listName: 'История Боба' },
      });
      await db.listHistoryItem.create({
        data: {
          historyId: 'bob-history',
          productId: 'milk-global',
          variantId: 'milk-variant',
          productName: 'Молоко',
          productEmoji: '🥛',
          categoryName: 'Фрукты',
          addedAt: new Date(),
        },
      });
      // Alice's own rows that point at her private product: deleted with her account.
      await db.item.create({ data: { listId: 'alice-list', productId: 'alice-private' } });
      await db.item.create({
        data: { listId: 'alice-list', productId: 'milk-global', variantId: 'alice-variant' },
      });
      await db.favorite.create({ data: { userId: 'alice', productId: 'alice-private' } });
      await db.variantFavorite.create({ data: { userId: 'alice', variantId: 'alice-variant' } });

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'deleted' });
      expect((await db.user.findMany()).map((u) => u.id)).toEqual(['bob']);
      expect(await db.emailVerificationToken.count()).toBe(0);
      expect(await db.passwordResetToken.count()).toBe(0);

      const products = await db.product.findMany({ orderBy: { id: 'asc' } });
      expect(products.map((p) => [p.id, p.isGlobal, p.createdById])).toEqual([
        ['bob-private', false, 'bob'],
        ['milk-global', true, null],
      ]);
      expect(
        (await db.productVariant.findMany({ orderBy: { id: 'asc' } })).map((v) => v.id)
      ).toEqual(['milk-variant']);

      const bobItems = await db.item.findMany({ where: { listId: 'bob-list' } });
      expect(bobItems.map((i) => [i.productId, i.variantId]).sort()).toEqual([
        ['bob-private', null],
        ['milk-global', 'milk-variant'],
      ]);
      expect((await db.favorite.findMany()).map((f) => [f.userId, f.productId])).toEqual([
        ['bob', 'milk-global'],
      ]);
      expect((await db.variantFavorite.findMany()).map((vf) => vf.userId)).toEqual(['bob']);
      expect(
        (await db.listHistoryItem.findMany()).map((hi) => [hi.productId, hi.variantId])
      ).toEqual([['milk-global', 'milk-variant']]);
      expect((await db.list.findMany()).map((l) => l.userId)).toEqual(['bob']);
    });
  });
});
