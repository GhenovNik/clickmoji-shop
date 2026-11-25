// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GuestCleanupDbClient, MilestoneHandOff } from './guest-cleanup';

/**
 * Real-PostgreSQL check that cleaning up a stale guest keeps the funnel of the active guest that
 * shares its signed funnel cookie.
 *
 * Start A, then Start B with the same cookie, then the cleanup removes A before B has added any
 * item event (in either order A is stale or still fresh when B starts). B must take over the
 * chain's shared milestones at that cleanup and keep one full chain after its first purchase. The
 * inverse, where the newer guest ages and the older one stays active, must keep the older chain.
 * The ordinary chain that shares the cookie keeps its owner, and once B is stale too the chain
 * obeys retention.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a disposable local database, e.g.:
 *   INTEGRATION_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/clickmoji_handoff \
 *     npx vitest run src/lib/funnel.guest-handoff.integration
 * The URL is refused unless it names localhost, so no shared or production database can be used.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const isLocal = url ? ['localhost', '127.0.0.1'].includes(new URL(url).hostname) : false;

if (url && isLocal) {
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET = `integration-${randomUUID()}`;
}

const doubles = vi.hoisted(() => ({
  auth: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));

vi.mock('@/lib/auth', () => ({
  auth: doubles.auth,
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return {
    ...actual,
    checkRateLimit: async () => ({ allowed: true, resetAt: 0 }),
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url || !isLocal)(
  'stale guest cleanup keeps the active guest chain on PostgreSQL',
  () => {
    const guestId = `guest_pg17handoff_${randomUUID()}`;
    const extraChainIds: string[] = [];
    const createdUserIds: string[] = [];

    let prisma: typeof import('@/lib/prisma').prisma;
    let POST: typeof import('@/app/api/auth/guest/route').POST;
    let signGuestId: typeof import('./funnel').signGuestId;
    let FUNNEL_GUEST_COOKIE: typeof import('./funnel').FUNNEL_GUEST_COOKIE;
    let recordFunnelEvent: typeof import('./funnel').recordFunnelEvent;
    let cleanupInactiveGuests: typeof import('./guest-cleanup').cleanupInactiveGuests;
    let FUNNEL_EVENT_REPORT_SELECT: typeof import('./funnel-analytics').FUNNEL_EVENT_REPORT_SELECT;
    let toFunnelEventRecords: typeof import('./funnel-analytics').toFunnelEventRecords;
    let aggregateFunnelWindow: typeof import('./funnel-analytics').aggregateFunnelWindow;
    let handOffSharedMilestones: typeof import('./guest-cleanup').handOffSharedMilestones;
    let recordGuestActivity: typeof import('./guest-activity').recordGuestActivity;

    const startRequest = (cookieGuestId: string) => {
      const signed = signGuestId(cookieGuestId);
      if (!signed) throw new Error('Auth secret missing for integration test');
      return new Request('http://localhost/api/auth/guest', {
        method: 'POST',
        headers: { cookie: `${FUNNEL_GUEST_COOKIE}=${encodeURIComponent(signed)}` },
      });
    };

    async function start(cookieGuestId: string): Promise<string> {
      const response = await POST(startRequest(cookieGuestId));
      expect(response.status).toBe(201);
      const body = (await response.json()) as { user: { id: string } };
      createdUserIds.push(body.user.id);
      return body.user.id;
    }

    /** Moves a guest's last activity into the past, so the cleanup treats it as stale. */
    const ageGuest = (userId: string, days: number) =>
      prisma.user.update({
        where: { id: userId },
        data: { guestLastActiveAt: new Date(Date.now() - days * DAY_MS) },
      });

    const chainRows = () =>
      prisma.funnelEvent.findMany({
        where: { guestId },
        select: FUNNEL_EVENT_REPORT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

    const typesOwnedBy = async (userId: string) =>
      (
        await prisma.funnelEvent.findMany({
          where: { guestId, userId },
          select: { type: true },
        })
      )
        .map((row) => row.type)
        .sort();

    beforeAll(async () => {
      ({ prisma } = await import('@/lib/prisma'));
      ({ POST } = await import('@/app/api/auth/guest/route'));
      ({ signGuestId, FUNNEL_GUEST_COOKIE, recordFunnelEvent } = await import('./funnel'));
      ({ cleanupInactiveGuests, handOffSharedMilestones } = await import('./guest-cleanup'));
      ({ recordGuestActivity } = await import('./guest-activity'));
      ({ FUNNEL_EVENT_REPORT_SELECT, toFunnelEventRecords, aggregateFunnelWindow } =
        await import('./funnel-analytics'));
    });

    afterAll(async () => {
      if (!prisma) return;
      await prisma.funnelEvent.deleteMany({
        where: { guestId: { in: [guestId, ...extraChainIds] } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await prisma.$disconnect();
    });

    it('keeps the active guest full chain when the stale guest is cleaned before the replacement buys', async () => {
      // Browser visit, then guest A starts with the cookie. A owns VISIT, REGISTER and LIST_CREATE.
      await recordFunnelEvent({ type: 'VISIT', userId: null, guestId });
      const guestA = await start(guestId);
      await ageGuest(guestA, 45);

      // An ordinary registration from the same browser owns its own milestones under this cookie.
      const ordinary = await prisma.user.create({
        data: { email: `ordinary-${guestId}@example.test`, isGuest: false },
      });
      createdUserIds.push(ordinary.id);
      await recordFunnelEvent({ type: 'REGISTER', userId: ordinary.id, guestId });
      await recordFunnelEvent({ type: 'LIST_CREATE', userId: ordinary.id, guestId });

      // Guest B starts with the same cookie (A's session is gone). Its start joins the chain with a
      // VISIT of its own; the stale A still holds the shared milestones until its cleanup.
      const guestB = await start(guestId);
      // A owns the browser's VISIT and its own start VISIT, plus REGISTER and LIST_CREATE.
      expect(await typesOwnedBy(guestA)).toEqual(['LIST_CREATE', 'REGISTER', 'VISIT', 'VISIT']);
      expect(await typesOwnedBy(guestB)).toEqual(['VISIT']);

      // A repeated start from B's live session only reuses B and writes nothing.
      doubles.auth.mockResolvedValueOnce({
        user: { id: guestB },
        sessionIssuedAt: Math.floor(Date.now() / 1000),
      });
      const repeated = await POST(startRequest(guestId));
      expect(repeated.status).toBe(200);
      expect(((await repeated.json()) as { reused: boolean }).reused).toBe(true);
      expect(await typesOwnedBy(guestB)).toEqual(['VISIT']);

      // Cleanup removes only the stale guest A. It owns nothing of the chain any more.
      const cleanup = await cleanupInactiveGuests({ db: prisma, inactiveDays: 30 });
      expect(cleanup.deletedCount).toBeGreaterThanOrEqual(1);
      expect(await prisma.user.findUnique({ where: { id: guestA } })).toBeNull();
      expect(await prisma.user.findUnique({ where: { id: guestB } })).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: ordinary.id } })).not.toBeNull();
      // B now holds the moved VISIT, REGISTER and LIST_CREATE, plus its own start VISIT.
      expect(await typesOwnedBy(guestB)).toEqual(['LIST_CREATE', 'REGISTER', 'VISIT', 'VISIT']);

      // Only now does B buy: the first purchase lands on the chain that B already owns.
      await pause(5);
      await recordFunnelEvent({ type: 'ITEM_ADD', userId: guestB, guestId });
      await pause(5);
      await recordFunnelEvent({ type: 'ITEM_PURCHASE', userId: guestB, guestId });

      // B now owns one full guest chain: one REGISTER and one LIST_CREATE, and VISIT rows only.
      expect(await typesOwnedBy(guestB)).toEqual([
        'ITEM_ADD',
        'ITEM_PURCHASE',
        'LIST_CREATE',
        'REGISTER',
        'VISIT',
        'VISIT',
      ]);

      // The ordinary chain sharing the cookie keeps its own owner and milestones.
      expect(await typesOwnedBy(ordinary.id)).toEqual(['LIST_CREATE', 'REGISTER']);

      const now = new Date(Date.now() + 60_000);
      const rows = await chainRows();
      const guestRows = rows.filter((row) => row.userId !== ordinary.id);
      const chain = aggregateFunnelWindow(toFunnelEventRecords(guestRows), 1, now);
      expect(chain.stages.map((stage) => stage.count)).toEqual([1, 1, 1, 1, 1]);
      expect(chain.overallRate).toBe(1);

      // A repeated cleanup changes nothing.
      const again = await cleanupInactiveGuests({ db: prisma, inactiveDays: 30 });
      expect(again.deletedCount).toBe(0);
      expect(await typesOwnedBy(guestB)).toEqual([
        'ITEM_ADD',
        'ITEM_PURCHASE',
        'LIST_CREATE',
        'REGISTER',
        'VISIT',
        'VISIT',
      ]);
    });

    it('obeys retention for the last stale guest: no active owner means the chain is removed', async () => {
      const guestB = await prisma.user.findFirst({
        where: { isGuest: true, funnelEvents: { some: { guestId, userId: { not: null } } } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!guestB) throw new Error('Active guest of the chain is missing from the previous step');

      await ageGuest(guestB.id, 45);
      const cleanup = await cleanupInactiveGuests({ db: prisma, inactiveDays: 30 });
      expect(cleanup.deletedCount).toBeGreaterThanOrEqual(1);
      expect(await prisma.user.findUnique({ where: { id: guestB.id } })).toBeNull();

      // Only the ordinary chain remains under the shared guestId; no guest-owned rows are left.
      const remaining = await chainRows();
      expect(remaining.every((row) => row.userId !== null)).toBe(true);
      expect(remaining.some((row) => row.userId === guestB.id)).toBe(false);
    });

    /** Count of one guest's chain rows per type, so duplicates show up. */
    const ownedCounts = async (userId: string, chainId: string) => {
      const rows = await prisma.funnelEvent.findMany({
        where: { guestId: chainId, userId },
        select: { type: true },
      });
      const counts: Record<string, number> = {};
      for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1;
      return counts;
    };

    const reportOf = async (chainId: string) => {
      const rows = await prisma.funnelEvent.findMany({
        where: { guestId: chainId },
        select: FUNNEL_EVENT_REPORT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return aggregateFunnelWindow(toFunnelEventRecords(rows), 1, new Date(Date.now() + 60_000));
    };

    it('keeps one full chain for the newer guest when the older guest is cleaned in the normal start order', async () => {
      // Visit, Start A, then Start B with the same cookie while A is still fresh. B adds nothing yet.
      const chainId = `guest_pg17order_${randomUUID()}`;
      extraChainIds.push(chainId);
      await recordFunnelEvent({ type: 'VISIT', userId: null, guestId: chainId });
      const guestA = await start(chainId);
      const guestB = await start(chainId);

      // A ages past the cutoff. Cleanup runs while B is fresh and has no item events.
      await ageGuest(guestA, 45);
      const cleanup = await cleanupInactiveGuests({ db: prisma, inactiveDays: 30 });
      expect(cleanup.deletedCount).toBeGreaterThanOrEqual(1);
      expect(await prisma.user.findUnique({ where: { id: guestA } })).toBeNull();
      expect(await prisma.user.findUnique({ where: { id: guestB } })).not.toBeNull();

      // B keeps exactly one REGISTER and one LIST_CREATE, and the chain still starts at its visit.
      const owned = await ownedCounts(guestB, chainId);
      expect(owned.REGISTER).toBe(1);
      expect(owned.LIST_CREATE).toBe(1);
      expect(owned.VISIT).toBeGreaterThanOrEqual(1);
      const beforePurchase = await reportOf(chainId);
      expect(beforePurchase.stages.map((stage) => stage.count)).toEqual([1, 1, 1, 0, 0]);

      // B's first purchase lands on the chain it already owns.
      await pause(5);
      await recordFunnelEvent({ type: 'ITEM_ADD', userId: guestB, guestId: chainId });
      await pause(5);
      await recordFunnelEvent({ type: 'ITEM_PURCHASE', userId: guestB, guestId: chainId });

      const chain = await reportOf(chainId);
      expect(chain.stages.map((stage) => stage.count)).toEqual([1, 1, 1, 1, 1]);
      expect(chain.overallRate).toBe(1);
    });

    it('keeps the older active guest chain when the newer guest ages first', async () => {
      // Visit, Start A, Start B. A stays active; B is the one that ages and gets cleaned.
      const chainId = `guest_pg17inverse_${randomUUID()}`;
      extraChainIds.push(chainId);
      await recordFunnelEvent({ type: 'VISIT', userId: null, guestId: chainId });
      const guestA = await start(chainId);
      const guestB = await start(chainId);
      await ageGuest(guestB, 45);

      const cleanup = await cleanupInactiveGuests({ db: prisma, inactiveDays: 30 });
      expect(cleanup.deletedCount).toBeGreaterThanOrEqual(1);
      expect(await prisma.user.findUnique({ where: { id: guestB } })).toBeNull();
      expect(await prisma.user.findUnique({ where: { id: guestA } })).not.toBeNull();

      // A still owns exactly one REGISTER and one LIST_CREATE, and completes the chain itself.
      const owned = await ownedCounts(guestA, chainId);
      expect(owned.REGISTER).toBe(1);
      expect(owned.LIST_CREATE).toBe(1);
      await pause(5);
      await recordFunnelEvent({ type: 'ITEM_ADD', userId: guestA, guestId: chainId });
      await pause(5);
      await recordFunnelEvent({ type: 'ITEM_PURCHASE', userId: guestA, guestId: chainId });

      const chain = await reportOf(chainId);
      expect(chain.stages.map((stage) => stage.count)).toEqual([1, 1, 1, 1, 1]);
      expect(chain.overallRate).toBe(1);
    });

    /** Owned rows of one user on one funnel chain, per type, sorted so duplicates show up. */
    const chainTypesOf = async (userId: string, chainId: string) =>
      (
        await prisma.funnelEvent.findMany({
          where: { guestId: chainId, userId },
          select: { type: true },
        })
      )
        .map((row) => row.type)
        .sort();

    /** Starts A on a fresh chain, ages it past the cutoff, then starts B, the fresh replacement. */
    async function staleAWithFreshB(chainId: string) {
      extraChainIds.push(chainId);
      await recordFunnelEvent({ type: 'VISIT', userId: null, guestId: chainId });
      const guestA = await start(chainId);
      await ageGuest(guestA, 45);
      const guestB = await start(chainId);
      expect(await chainTypesOf(guestA, chainId)).toEqual([
        'LIST_CREATE',
        'REGISTER',
        'VISIT',
        'VISIT',
      ]);
      expect(await chainTypesOf(guestB, chainId)).toEqual(['VISIT']);
      return { guestA, guestB };
    }

    it('does not move the milestones of a guest touched after the scan, and keeps its chain for later', async () => {
      const chainId = `guest_pg17touchscan_${randomUUID()}`;
      const { guestA, guestB } = await staleAWithFreshB(chainId);

      // Cleanup selects A as a candidate; A's activity lands before the hand-off and the delete.
      let touched = false;
      const racing: GuestCleanupDbClient = {
        $transaction: (run) => prisma.$transaction(run),
        user: {
          count: (args) => prisma.user.count(args),
          findMany: async (args) => {
            const rows = await prisma.user.findMany(args);
            if (!touched) {
              touched = true;
              expect(await recordGuestActivity(guestA)).toBe(true);
            }
            return rows;
          },
          deleteMany: (args) => prisma.user.deleteMany(args),
        },
      };
      await cleanupInactiveGuests({ db: racing, inactiveDays: 30 });
      expect(touched).toBe(true);

      // A is active again: it is not deleted, and its shared milestones stay on A, not on B.
      expect(await prisma.user.findUnique({ where: { id: guestA } })).not.toBeNull();
      expect(await chainTypesOf(guestA, chainId)).toEqual([
        'LIST_CREATE',
        'REGISTER',
        'VISIT',
        'VISIT',
      ]);
      expect(await chainTypesOf(guestB, chainId)).toEqual(['VISIT']);

      // Later B expires while A is active: B hands nothing off, and A keeps the whole chain.
      await ageGuest(guestB, 45);
      const later = await cleanupInactiveGuests({ db: prisma, inactiveDays: 30 });
      expect(later.deletedCount).toBeGreaterThanOrEqual(1);
      expect(await prisma.user.findUnique({ where: { id: guestB } })).toBeNull();
      expect(await chainTypesOf(guestA, chainId)).toEqual([
        'LIST_CREATE',
        'REGISTER',
        'VISIT',
        'VISIT',
      ]);

      // A's first purchase lands on the full chain it kept.
      await pause(5);
      await recordFunnelEvent({ type: 'ITEM_ADD', userId: guestA, guestId: chainId });
      await pause(5);
      await recordFunnelEvent({ type: 'ITEM_PURCHASE', userId: guestA, guestId: chainId });
      const chain = await reportOf(chainId);
      expect(chain.stages.map((stage) => stage.count)).toEqual([1, 1, 1, 1, 1]);
    });

    it('makes a touch that arrives during the hand-off wait for the commit, then find no guest', async () => {
      const chainId = `guest_pg17touchlock_${randomUUID()}`;
      const { guestA, guestB } = await staleAWithFreshB(chainId);

      let pending: Promise<boolean> | undefined;
      let settledBeforeCommit: boolean | undefined;
      const handOffWithTouch: MilestoneHandOff = async (input, tx) => {
        let settled = false;
        pending = recordGuestActivity(guestA).finally(() => {
          settled = true;
        });
        // The cleanup holds A's row here. The touch has to wait for the commit instead of landing.
        await pause(300);
        settledBeforeCommit = settled;
        return handOffSharedMilestones(input, tx);
      };

      const cleanup = await cleanupInactiveGuests({
        db: prisma,
        inactiveDays: 30,
        handOff: handOffWithTouch,
      });
      expect(settledBeforeCommit).toBe(false);
      expect(await pending).toBe(false);
      expect(cleanup.deletedCount).toBeGreaterThanOrEqual(1);
      expect(await prisma.user.findUnique({ where: { id: guestA } })).toBeNull();
      // A's shared milestones moved with its delete, so B now owns the full set.
      expect(await chainTypesOf(guestB, chainId)).toEqual([
        'LIST_CREATE',
        'REGISTER',
        'VISIT',
        'VISIT',
      ]);
    });
  }
);
