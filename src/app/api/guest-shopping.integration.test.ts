// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { decode } from 'next-auth/jwt';

// Exercises the server-backed guest shopping lifecycle against a real disposable PostgreSQL
// database: guest creation on Start, funnel correlation, lists, adding, purchasing, history
// completion/restore, cross-account isolation, deleted-guest session rejection, guest AI bounds,
// and inactive guest cleanup.
//
// Opt-in like list-operations.integration.test.ts:
//   INTEGRATION_DATABASE_URL=postgresql://... npx vitest run src/app/api/guest-shopping

const url = process.env.INTEGRATION_DATABASE_URL;

const authHolder = vi.hoisted(() => ({
  session: null as {
    sessionIssuedAt?: number;
    user: { id: string; role: string; email?: string | null; isGuest?: boolean };
  } | null,
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    auth: async () => authHolder.session,
  };
});

vi.mock('@/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { createPrismaPgAdapter } = await import('@/lib/prisma-adapter');
  return {
    prisma: new PrismaClient({
      adapter: createPrismaPgAdapter(process.env.INTEGRATION_DATABASE_URL),
    }),
  };
});

describe.skipIf(!url)('server guest shopping on PostgreSQL', () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const createdUserIds: string[] = [];
  let db: PrismaClient;
  let categoryId: string;
  let globalProductId: string;
  let privateProductOtherId: string;

  let routes: {
    guestAuth: typeof import('@/app/api/auth/guest/route');
    lists: typeof import('@/app/api/lists/route');
    listById: typeof import('@/app/api/lists/[listId]/route');
    addItems: typeof import('@/app/api/lists/[listId]/items/route');
    updateItem: typeof import('@/app/api/lists/[listId]/items/[itemId]/route');
    history: typeof import('@/app/api/history/route');
    restore: typeof import('@/app/api/history/[historyId]/restore/route');
    importText: typeof import('@/app/api/lists/import-text/route');
    smartCreate: typeof import('@/app/api/products/smart-create/route');
    register: typeof import('@/app/api/auth/register/route');
  };

  beforeAll(async () => {
    process.env.AUTH_SECRET = 'integration-test-auth-secret-1667';
    const { PrismaClient } = await import('@prisma/client');
    const { createPrismaPgAdapter } = await import('@/lib/prisma-adapter');
    db = new PrismaClient({ adapter: createPrismaPgAdapter(url) });

    routes = {
      guestAuth: await import('@/app/api/auth/guest/route'),
      lists: await import('@/app/api/lists/route'),
      listById: await import('@/app/api/lists/[listId]/route'),
      addItems: await import('@/app/api/lists/[listId]/items/route'),
      updateItem: await import('@/app/api/lists/[listId]/items/[itemId]/route'),
      history: await import('@/app/api/history/route'),
      restore: await import('@/app/api/history/[historyId]/restore/route'),
      importText: await import('@/app/api/lists/import-text/route'),
      smartCreate: await import('@/app/api/products/smart-create/route'),
      register: await import('@/app/api/auth/register/route'),
    };

    const category = await db.category.create({
      data: {
        name: `guest-it-${suffix}`,
        nameEn: `guest-it-${suffix}`,
        emoji: '🧪',
        order: 2_000_000 + Math.floor(Math.random() * 1_000_000),
      },
    });
    categoryId = category.id;

    const globalProduct = await db.product.create({
      data: {
        name: `Молоко-${suffix}`,
        nameEn: `Milk-${suffix}`,
        emoji: '🥛',
        categoryId,
        isGlobal: true,
      },
    });
    globalProductId = globalProduct.id;

    const ownerUser = await db.user.create({
      data: {
        email: `owner-${suffix}@example.test`,
        isGuest: false,
      },
    });
    createdUserIds.push(ownerUser.id);

    const privateProduct = await db.product.create({
      data: {
        name: `Секрет-${suffix}`,
        nameEn: `Secret-${suffix}`,
        emoji: '🧀',
        categoryId,
        isGlobal: false,
        createdById: ownerUser.id,
      },
    });
    privateProductOtherId = privateProduct.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.funnelEvent.deleteMany({
      where: { guestId: { startsWith: `guest_it_${suffix}` } },
    });
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await db.category.deleteMany({ where: { id: categoryId } });
    await db.$disconnect();
  });

  it('runs guest Start -> list -> add -> purchase -> history -> restore with funnel correlation, isolation, AI block, and cleanup', async () => {
    const { FUNNEL_GUEST_COOKIE, recordFunnelEvent, signGuestId } = await import('@/lib/funnel');
    const { NEXTAUTH_SESSION_COOKIE } = await import('@/lib/guest');
    const { authOptions } = await import('@/lib/auth');
    const { cleanupInactiveGuests } = await import('@/lib/guest-cleanup');
    const { getFunnelReport } = await import('@/lib/funnel-analytics');

    const visitGuestId = `guest_it_${suffix}_0001`;
    const signedVisitCookie = signGuestId(visitGuestId) ?? '';
    await recordFunnelEvent({ type: 'VISIT', guestId: visitGuestId, userId: null });

    // 1. Start creates a real User (isGuest=true) + starter lists + signed NextAuth JWT cookie.
    authHolder.session = null;
    const guestRes = await routes.guestAuth.POST(
      new Request('http://localhost:3000/api/auth/guest', {
        method: 'POST',
        headers: {
          cookie: `NEXT_LOCALE=ru; ${FUNNEL_GUEST_COOKIE}=${signedVisitCookie}`,
        },
      })
    );
    expect(guestRes.status).toBe(201);
    const { user: guestUser } = (await guestRes.json()) as {
      user: { id: string; isGuest: boolean };
    };
    createdUserIds.push(guestUser.id);
    expect(guestUser.isGuest).toBe(true);

    const setCookie = guestRes.headers.get('set-cookie') ?? '';
    const jwtMatch = setCookie.match(new RegExp(`${NEXTAUTH_SESSION_COOKIE}=([^;]+)`));
    const decodedJwt = await decode({
      token: jwtMatch![1],
      secret: process.env.AUTH_SECRET!,
    });
    expect(decodedJwt?.id).toBe(guestUser.id);

    // Valid new guest session passes NextAuth JWT callback (including same-second createdAt).
    const refreshedJwt = await authOptions.callbacks!.jwt!({ token: decodedJwt! } as never);
    expect(refreshedJwt.id).toBe(guestUser.id);
    expect(refreshedJwt.isGuest).toBe(true);

    authHolder.session = {
      sessionIssuedAt: decodedJwt!.sessionIssuedAt as number,
      user: {
        id: guestUser.id,
        role: 'USER',
        email: decodedJwt!.email as string,
        isGuest: true,
      },
    };

    const reqHeaders = {
      'content-type': 'application/json',
      cookie: `NEXT_LOCALE=ru; ${FUNNEL_GUEST_COOKIE}=${signedVisitCookie}`,
    };

    // 2. Guest lists, adding, purchasing, history completion and restore.
    const listsRes = await routes.lists.GET(
      new Request('http://localhost/api/lists', { headers: reqHeaders })
    );
    expect(listsRes.status).toBe(200);
    const starterLists = (await listsRes.json()) as Array<{
      id: string;
      name: string;
      isActive: boolean;
    }>;
    expect(starterLists).toHaveLength(5);
    const activeList = starterLists.find((l) => l.isActive)!;

    await new Promise((r) => setTimeout(r, 10));
    const addRes = await routes.addItems.POST(
      new Request(`http://localhost/api/lists/${activeList.id}/items`, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ items: [{ productId: globalProductId, note: '1 л' }] }),
      }),
      { params: Promise.resolve({ listId: activeList.id }) }
    );
    expect(addRes.status).toBe(200);
    const { createdItems } = (await addRes.json()) as { createdItems: Array<{ id: string }> };

    await new Promise((r) => setTimeout(r, 10));
    const purchaseRes = await routes.updateItem.PUT(
      new Request(`http://localhost/api/lists/${activeList.id}/items/${createdItems[0].id}`, {
        method: 'PUT',
        headers: reqHeaders,
        body: JSON.stringify({ isPurchased: true }),
      }),
      { params: Promise.resolve({ listId: activeList.id, itemId: createdItems[0].id }) }
    );
    expect(purchaseRes.status).toBe(200);

    const completeRes = await routes.history.POST(
      new Request('http://localhost/api/history', {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ listId: activeList.id }),
      })
    );
    expect(completeRes.status).toBe(200);
    const historyBody = (await completeRes.json()) as {
      id: string;
      items: Array<{ productId: string }>;
    };
    expect(historyBody.items).toHaveLength(1);

    const historyListRes = await routes.history.GET(
      new Request('http://localhost/api/history', { headers: reqHeaders })
    );
    expect(historyListRes.status).toBe(200);
    expect(await historyListRes.json()).toHaveLength(1);

    const restoreRes = await routes.restore.POST(
      new Request(`http://localhost/api/history/${historyBody.id}/restore`, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ historyId: historyBody.id }) }
    );
    expect(restoreRes.status).toBe(200);
    expect((await restoreRes.json()).createdCount).toBe(1);

    // Funnel report connects VISIT -> REGISTER -> LIST_CREATE -> ITEM_ADD -> ITEM_PURCHASE for this guest.
    const report = await getFunnelReport();
    const oneDay = report.windows.find((w) => w.days === 1)!;
    expect(oneDay.stages.every((s) => s.count >= 1)).toBe(true);

    // 3. Guest AI is denied before quota counters / monthly budget.
    const importDenied = await routes.importText.POST(
      new Request('http://localhost/api/lists/import-text', {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ text: 'хлеб', listId: activeList.id }),
      })
    );
    expect(importDenied.status).toBe(403);
    const smartDenied = await routes.smartCreate.POST(
      new Request('http://localhost/api/products/smart-create', {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ productName: 'Хлеб' }),
      })
    );
    expect(smartDenied.status).toBe(403);
    expect(await db.aiUsageCounter.count({ where: { userId: guestUser.id } })).toBe(0);

    // 4. Cross-account isolation: another guest / regular user cannot read or add to guest's list.
    const otherGuest = await db.user.create({
      data: {
        email: `guest-other-${suffix}@guest.clickmoji.invalid`,
        isGuest: true,
        guestLastActiveAt: new Date(),
      },
    });
    createdUserIds.push(otherGuest.id);

    const isolatedSession = authHolder.session;
    // Guest cannot add another user's private product.
    const privateAddRes = await routes.addItems.POST(
      new Request(`http://localhost/api/lists/${activeList.id}/items`, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ items: [{ productId: privateProductOtherId }] }),
      }),
      { params: Promise.resolve({ listId: activeList.id }) }
    );
    expect(privateAddRes.status).toBe(404);

    // Other guest cannot access guestUser's list.
    authHolder.session = {
      sessionIssuedAt: Math.floor(otherGuest.createdAt.getTime() / 1000),
      user: { id: otherGuest.id, role: 'USER', email: otherGuest.email, isGuest: true },
    };
    const crossListRes = await routes.listById.GET(
      new Request(`http://localhost/api/lists/${activeList.id}`),
      { params: Promise.resolve({ listId: activeList.id }) }
    );
    expect(crossListRes.status).toBe(404);
    authHolder.session = isolatedSession;

    // 5. Cleanup keeps regular users and active guests, deletes only inactive guests.
    const staleDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const staleGuest = await db.user.create({
      data: {
        email: `guest-stale-${suffix}@guest.clickmoji.invalid`,
        isGuest: true,
        guestLastActiveAt: staleDate,
        createdAt: staleDate,
      },
    });
    createdUserIds.push(staleGuest.id);
    await db.list.create({
      data: { userId: staleGuest.id, name: 'Stale', isActive: true },
    });

    const regularOldUser = await db.user.create({
      data: {
        email: `regular-old-${suffix}@example.test`,
        isGuest: false,
        guestLastActiveAt: null,
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      },
    });
    createdUserIds.push(regularOldUser.id);

    const cleanupRes = await cleanupInactiveGuests({ db, inactiveDays: 30 });
    expect(cleanupRes.deletedCount).toBeGreaterThanOrEqual(1);
    expect(await db.user.findUnique({ where: { id: staleGuest.id } })).toBeNull();
    expect(await db.user.findUnique({ where: { id: guestUser.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: regularOldUser.id } })).not.toBeNull();
    expect(await db.product.findUnique({ where: { id: globalProductId } })).not.toBeNull();

    // 6. Deleted guest JWT is rejected even if a new user is later created with the same email.
    await db.user.delete({ where: { id: guestUser.id } });
    const replacement = await db.user.create({
      data: { email: decodedJwt!.email as string, isGuest: false },
    });
    createdUserIds.push(replacement.id);

    await expect(authOptions.callbacks!.jwt!({ token: decodedJwt! } as never)).rejects.toThrow();
  });

  it('promotes the live guest in place when registration runs from the same browser (AGE-1667)', async () => {
    const { FUNNEL_GUEST_COOKIE, signGuestId } = await import('@/lib/funnel');
    const { NEXTAUTH_SESSION_COOKIE } = await import('@/lib/guest');
    const { authOptions } = await import('@/lib/auth');

    const visitGuestId = `guest_it_${suffix}_0002`;
    const funnelCookie = `${FUNNEL_GUEST_COOKIE}=${signGuestId(visitGuestId) ?? ''}`;
    const startHeaders = { cookie: `NEXT_LOCALE=ru; ${funnelCookie}` };
    authHolder.session = null;

    const startRes = await routes.guestAuth.POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST', headers: startHeaders })
    );
    expect(startRes.status).toBe(201);
    const { user: guest } = (await startRes.json()) as { user: { id: string } };
    createdUserIds.push(guest.id);
    const sessionToken = (startRes.headers.get('set-cookie') ?? '').match(
      new RegExp(`${NEXTAUTH_SESSION_COOKIE}=([^;]+)`)
    )![1];

    const decoded = await decode({ token: sessionToken, secret: process.env.AUTH_SECRET! });
    authHolder.session = {
      sessionIssuedAt: decoded!.sessionIssuedAt as number,
      user: { id: guest.id, role: 'USER', email: decoded!.email as string, isGuest: true },
    };
    const guestHeaders = { 'content-type': 'application/json', ...startHeaders };
    const lists = (await (
      await routes.lists.GET(new Request('http://localhost/api/lists', { headers: guestHeaders }))
    ).json()) as Array<{ id: string; isActive: boolean }>;
    const activeList = lists.find((l) => l.isActive)!;
    const addRes = await routes.addItems.POST(
      new Request(`http://localhost/api/lists/${activeList.id}/items`, {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({ items: [{ productId: globalProductId, note: 'stays-guest' }] }),
      }),
      { params: Promise.resolve({ listId: activeList.id }) }
    );
    expect(addRes.status).toBe(200);
    const guestListsBefore = await db.list.count({ where: { userId: guest.id } });

    // Registration with the live guest cookie promotes that guest in place: same User.id, lists kept.
    const previousVerification = process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
    process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
    const regularEmail = `regular-${suffix}@example.test`;
    try {
      const registerRes = await routes.register.POST(
        new Request('http://localhost:3000/api/auth/register', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `${startHeaders.cookie}; ${NEXTAUTH_SESSION_COOKIE}=${sessionToken}`,
          },
          body: JSON.stringify({
            email: regularEmail,
            password: `Aa1-${randomUUID()}`,
            name: 'Regular',
          }),
        })
      );
      expect(registerRes.status).toBe(201);
      const registerBody = (await registerRes.json()) as {
        promoted?: boolean;
        user: { id: string; email: string };
      };
      expect(registerBody.promoted).toBe(true);
      expect(registerBody.user.id).toBe(guest.id);
    } finally {
      if (previousVerification === undefined) delete process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
      else process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = previousVerification;
    }

    // The same row is now an account: same id, same lists and items, the email the user chose.
    expect(await db.user.findUnique({ where: { id: guest.id } })).toMatchObject({
      isGuest: false,
      email: regularEmail,
    });
    expect(await db.list.count({ where: { userId: guest.id } })).toBe(guestListsBefore);
    expect(await db.item.count({ where: { listId: activeList.id } })).toBe(1);
    expect(await db.user.count({ where: { email: regularEmail } })).toBe(1);

    // The guest's old JWT is rejected: the row is no longer a guest.
    await expect(authOptions.callbacks!.jwt!({ token: decoded! } as never)).rejects.toThrow(
      'Guest session superseded by account'
    );
  });
});
