// @vitest-environment node
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from './prisma-adapter';
import type { deleteAccount as DeleteAccountFn } from './account';

// Route handlers read the signed-in user from requireUser; the rest of the stack is real.
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth-guards', () => ({ requireUser: auth.requireUser }));

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

  describe('another user referencing a private product keeps that product', () => {
    it('deletes the account and keeps another list item on a private product, with its note', async () => {
      await db.item.create({
        data: { listId: 'bob-list', productId: 'alice-private', note: 'Бобу' },
      });

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'deleted' });
      expect((await db.user.findMany()).map((u) => u.id)).toEqual(['bob']);
      expect(await db.list.findMany({ where: { userId: 'alice' } })).toEqual([]);
      expect(
        (await db.item.findMany({ where: { listId: 'bob-list' } })).map((i) => [
          i.productId,
          i.variantId,
          i.note,
        ])
      ).toEqual([['alice-private', null, 'Бобу']]);
      // The product is kept private with no owner, and its variant stays under it.
      expect(
        (await db.product.findMany({ orderBy: { id: 'asc' } })).map((p) => [
          p.id,
          p.isGlobal,
          p.createdById,
        ])
      ).toEqual([
        ['alice-private', false, null],
        ['milk-global', true, null],
      ]);
      expect(
        (await db.productVariant.findMany({ orderBy: { id: 'asc' } })).map((v) => v.id)
      ).toEqual(['alice-variant', 'milk-variant']);
    });

    it('keeps the private variant of a global product in another list item (independent variant FK)', async () => {
      await db.item.create({
        data: { listId: 'bob-list', productId: 'milk-global', variantId: 'alice-variant' },
      });

      const result = await deleteAccount({ userId: 'alice', password });

      expect(result).toEqual({ status: 'deleted' });
      expect(
        (await db.item.findMany({ where: { listId: 'bob-list' } })).map((i) => [
          i.productId,
          i.variantId,
        ])
      ).toEqual([['milk-global', 'alice-variant']]);
      expect(await db.product.findFirst({ where: { id: 'alice-private' } })).toMatchObject({
        isGlobal: false,
        createdById: null,
      });
      expect(await db.productVariant.findUnique({ where: { id: 'alice-variant' } })).toMatchObject({
        productId: 'alice-private',
      });
    });

    it('keeps another user favorite of a private product', async () => {
      await db.favorite.create({ data: { userId: 'bob', productId: 'alice-private' } });

      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      expect((await db.favorite.findMany()).map((f) => [f.userId, f.productId])).toEqual([
        ['bob', 'alice-private'],
      ]);
      expect(await db.product.findFirst({ where: { id: 'alice-private' } })).toMatchObject({
        isGlobal: false,
        createdById: null,
      });
    });

    it('keeps another user starred variant of a private product', async () => {
      await db.variantFavorite.create({ data: { userId: 'bob', variantId: 'alice-variant' } });

      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      expect((await db.variantFavorite.findMany()).map((vf) => [vf.userId, vf.variantId])).toEqual([
        ['bob', 'alice-variant'],
      ]);
      expect(await db.productVariant.findUnique({ where: { id: 'alice-variant' } })).not.toBeNull();
    });

    it('keeps another user history snapshot that points at a private product or its variant', async () => {
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

      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      expect(
        (await db.listHistoryItem.findMany({ orderBy: { id: 'asc' } })).map((hi) => [
          hi.productId,
          hi.variantId,
        ])
      ).toEqual(
        expect.arrayContaining([
          ['alice-private', null],
          ['milk-global', 'alice-variant'],
        ])
      );
      expect(await db.product.findFirst({ where: { id: 'alice-private' } })).toMatchObject({
        isGlobal: false,
        createdById: null,
      });
    });

    it('keeps another user history that pointed at the deleted list, with listId cleared (ListHistory.listId SetNull)', async () => {
      await db.listHistory.create({
        data: { id: 'bob-history', userId: 'bob', listId: 'alice-list', listName: 'История Боба' },
      });

      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      expect(await db.listHistory.findMany()).toEqual([
        expect.objectContaining({ id: 'bob-history', userId: 'bob', listId: null }),
      ]);
    });

    it('deletes the private products nobody else references and keeps only the referenced one', async () => {
      await db.product.create({
        data: {
          id: 'alice-free',
          name: 'Свободный',
          nameEn: 'Free',
          emoji: '🍪',
          categoryId: 'fruit',
          isGlobal: false,
          createdById: 'alice',
        },
      });
      await db.productVariant.create({
        data: {
          id: 'alice-free-variant',
          name: 'Свободный',
          nameEn: 'Free',
          emoji: '🍪',
          productId: 'alice-free',
        },
      });
      await db.item.create({ data: { listId: 'bob-list', productId: 'alice-private' } });

      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      expect((await db.product.findMany({ orderBy: { id: 'asc' } })).map((p) => p.id)).toEqual([
        'alice-private',
        'milk-global',
      ]);
      expect(
        (await db.productVariant.findMany({ orderBy: { id: 'asc' } })).map((v) => v.id)
      ).toEqual(['alice-variant', 'milk-variant']);
      expect(
        (await db.item.findMany({ where: { listId: 'bob-list' } })).map((i) => i.productId)
      ).toEqual(['alice-private']);
    });

    it('waits for an uncommitted concurrent reference to the private product, then keeps that reference', async () => {
      const inserted = barrier();
      const release = barrier();
      const writing = writer.$transaction(async (tx) => {
        await tx.item.create({ data: { listId: 'bob-list', productId: 'alice-private' } });
        inserted.resolve();
        await release.promise;
      });
      await inserted.promise;
      // Uncommitted from every other connection's point of view: the list has no Bob item yet.
      expect(await db.item.findMany({ where: { listId: 'bob-list' } })).toEqual([]);

      // The deletion must block on the row lock taken by the uncommitted FK insert, not read past it.
      const deleting = deleteAccount({ userId: 'alice', password });
      const stillBlocked = await Promise.race([
        deleting.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 500)),
      ]);
      expect(stillBlocked).toBe(true);

      release.resolve();
      await writing;

      expect(await deleting).toEqual({ status: 'deleted' });
      // The committed reference is read after the lock and keeps its product.
      expect(
        (await db.item.findMany({ where: { listId: 'bob-list' } })).map((i) => i.productId)
      ).toEqual(['alice-private']);
      expect(await db.product.findFirst({ where: { id: 'alice-private' } })).toMatchObject({
        isGlobal: false,
        createdById: null,
      });
    });
  });

  describe('visibility change racing the deletion', () => {
    // Polls pg_stat_activity until some other backend waits on a lock for a statement matching
    // `fragment`, so the test orders the race by observed lock state instead of by sleeping.
    async function waitForLockWaiter(fragment: string, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const [{ waiting }] = await db.$queryRaw<Array<{ waiting: number }>>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE ${fragment}`;
        if (waiting > 0) return;
        if (Date.now() >= deadline) throw new Error(`No backend waits on a lock for ${fragment}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it('keeps a formerly global product that was made private before deletion while another user references it', async () => {
      await db.item.create({ data: { listId: 'bob-list', productId: 'milk-global' } });
      await db.product.update({ where: { id: 'milk-global' }, data: { isGlobal: false } });

      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      expect(
        (await db.item.findMany({ where: { listId: 'bob-list' } })).map((i) => i.productId)
      ).toEqual(['milk-global']);
      expect(await db.product.findMany({ orderBy: { id: 'asc' } })).toEqual([
        expect.objectContaining({ id: 'milk-global', isGlobal: false, createdById: null }),
      ]);
    });

    it('keeps a foreign reference to a formerly global product when it turns private during deletion', async () => {
      // Bob's list references Alice's global product while it is still global. The deletion
      // must not treat it as her private product, so the reference must survive.
      await db.item.create({ data: { listId: 'bob-list', productId: 'milk-global' } });

      // Hold Alice's list lock in another transaction. The deletion then reaches its list step
      // with every product lock it has taken so far, and waits there.
      const holderLocked = barrier();
      const releaseHolder = barrier();
      const holder = writer.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM lists WHERE id = 'alice-list' FOR UPDATE`;
        holderLocked.resolve();
        await releaseHolder.promise;
      });
      await holderLocked.promise;

      let deleting: Promise<unknown> | undefined;
      let visibility: Promise<unknown> | undefined;
      try {
        deleting = deleteAccount({ userId: 'alice', password });
        await waitForLockWaiter('%FROM lists%');

        // The visibility change starts now. It must wait for the deletion to finish; if it can
        // commit while the deletion is still running, the deletion may cascade Bob's reference.
        visibility = writer.product
          .update({ where: { id: 'milk-global' }, data: { isGlobal: false } })
          .then(() => 'done' as const);
        const visibilityState = await Promise.race([
          visibility,
          waitForLockWaiter('%update%products%').then(() => 'blocked' as const),
        ]);
        expect(visibilityState).toBe('blocked');
      } finally {
        // Release on failure too, so a broken run fails fast instead of timing out the deletion.
        releaseHolder.resolve();
        await Promise.allSettled([holder, deleting, visibility].filter(Boolean));
      }

      expect(await deleting).toEqual({ status: 'deleted' });
      await visibility;

      // Bob's reference survives and the product is not cascaded away.
      const bobItems = await db.item.findMany({ where: { listId: 'bob-list' } });
      expect(bobItems.map((i) => [i.productId, i.variantId])).toEqual([['milk-global', null]]);
      const products = await db.product.findMany({ orderBy: { id: 'asc' } });
      expect(products.map((p) => [p.id, p.createdById])).toEqual([['milk-global', null]]);
      expect(await db.productVariant.findMany({ orderBy: { id: 'asc' } })).toEqual([
        expect.objectContaining({ id: 'milk-variant', productId: 'milk-global' }),
      ]);
      expect((await db.user.findMany()).map((u) => u.id)).toEqual(['bob']);
      expect(await db.list.findMany({ where: { userId: 'alice' } })).toEqual([]);
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

  // After Alice's deletion the legacy rows of Bob still point at her kept private variant
  // (alice-variant, of the ownerless alice-private). Ordinary reads must not serialize it, while
  // Bob's own consistent variant (milk-variant of the global milk-global) stays visible.
  describe('legacy foreign variant stays out of ordinary and export reads after deletion', () => {
    const bobRequest = (path: string, init?: RequestInit) =>
      new Request(`http://localhost${path}`, init);
    const jsonPost = (path: string, body: unknown) =>
      bobRequest(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    beforeEach(() => {
      auth.requireUser.mockResolvedValue({ session: { user: { id: 'bob' } } });
    });

    it('GET /api/lists/[listId] drops the foreign variant and its id but keeps the product and the own variant', async () => {
      await db.item.create({
        data: {
          listId: 'bob-list',
          productId: 'milk-global',
          variantId: 'alice-variant',
          note: 'чужой',
        },
      });
      await db.item.create({
        data: {
          listId: 'bob-list',
          productId: 'milk-global',
          variantId: 'milk-variant',
          note: 'свой',
        },
      });
      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      const { GET } = await import('@/app/api/lists/[listId]/route');
      const response = await GET(bobRequest('/api/lists/bob-list'), {
        params: Promise.resolve({ listId: 'bob-list' }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      const byNote = Object.fromEntries(
        (
          body.items as {
            note: string;
            productId: string;
            variantId: string | null;
            variant: { id: string } | null;
          }[]
        ).map((item) => [item.note, item])
      );
      expect(byNote['чужой']).toMatchObject({
        productId: 'milk-global',
        variantId: null,
        variant: null,
      });
      expect(byNote['свой']).toMatchObject({
        productId: 'milk-global',
        variantId: 'milk-variant',
        variant: { id: 'milk-variant', name: '3.2%' },
      });
      expect(JSON.stringify(body)).not.toContain('alice-variant');
      expect(JSON.stringify(body)).not.toContain('Ханикрисп');
    });

    it('the account export drops the same foreign variant from Bob list items', async () => {
      await db.item.create({
        data: { listId: 'bob-list', productId: 'milk-global', variantId: 'alice-variant' },
      });
      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      const { exportAccountData } = await import('./account');
      const exported = await exportAccountData('bob');
      const serialized = JSON.stringify(exported);

      expect(exported?.lists[0].items.map((item) => [item.product.id, item.variant])).toEqual([
        ['milk-global', null],
      ]);
      expect(serialized).not.toContain('alice-variant');
      expect(serialized).not.toContain('Ханикрисп');
    });

    it('GET /api/history hides the foreign snapshot variant and keeps the consistent one', async () => {
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
          variantEmoji: '🍎',
          addedAt: new Date(),
        },
      });
      await db.listHistoryItem.create({
        data: {
          historyId: 'bob-history',
          productId: 'milk-global',
          variantId: 'milk-variant',
          productName: 'Молоко',
          productEmoji: '🥛',
          categoryName: 'Фрукты',
          variantName: '3.2%',
          variantEmoji: '🥛',
          addedAt: new Date(),
        },
      });
      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      const { GET } = await import('@/app/api/history/route');
      const body = await (await GET(bobRequest('/api/history'))).json();

      expect(
        body[0].items
          .map((item: { variantId: string | null; variantName: string | null }) => [
            item.variantId,
            item.variantName,
          ])
          .sort()
      ).toEqual([
        [null, null],
        ['milk-variant', '3.2%'],
      ]);
      expect(JSON.stringify(body)).not.toContain('alice-variant');
      expect(JSON.stringify(body)).not.toContain('Ханикрисп');
    });

    it('completing a list copies only the own variant into the new snapshot', async () => {
      await db.item.create({
        data: { listId: 'bob-list', productId: 'milk-global', variantId: 'alice-variant' },
      });
      await db.item.create({
        data: { listId: 'bob-list', productId: 'milk-global', variantId: 'milk-variant' },
      });
      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      const { POST } = await import('@/app/api/history/route');
      const response = await POST(jsonPost('/api/history', { listId: 'bob-list' }));
      const created = await response.json();

      expect(response.status).toBe(200);
      const expected = [
        [null, null],
        ['milk-variant', '3.2%'],
      ];
      expect(
        created.items
          .map((item: { variantId: string | null; variantName: string | null }) => [
            item.variantId,
            item.variantName,
          ])
          .sort()
      ).toEqual(expected);
      expect(JSON.stringify(created)).not.toContain('alice-variant');
      expect(JSON.stringify(created)).not.toContain('Ханикрисп');
      const stored = await db.listHistoryItem.findMany({ where: { historyId: created.id } });
      expect(stored.map((item) => [item.variantId, item.variantName]).sort()).toEqual(expected);
    });

    it('restoring a snapshot recreates only the own variant link', async () => {
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
          addedAt: new Date(),
        },
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
      expect(await deleteAccount({ userId: 'alice', password })).toEqual({ status: 'deleted' });

      const { POST } = await import('@/app/api/history/[historyId]/restore/route');
      const response = await POST(jsonPost('/api/history/bob-history/restore', {}), {
        params: Promise.resolve({ historyId: 'bob-history' }),
      });
      const result = await response.json();

      expect(result).toMatchObject({ createdCount: 2, skippedCount: 0 });
      const restored = await db.item.findMany({ where: { listId: result.listId } });
      expect(restored).toHaveLength(2);
      expect(
        restored.filter((item) => item.variantId !== null).map((item) => item.variantId)
      ).toEqual(['milk-variant']);
      expect(restored.every((item) => item.productId === 'milk-global')).toBe(true);
    });
  });
});
