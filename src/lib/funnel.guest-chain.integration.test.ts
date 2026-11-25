// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Real-PostgreSQL check of one guest funnel chain under concurrent and repeated starts.
 *
 * Runs the real `POST /api/auth/guest` route. Two starts race with the same signed funnel cookie,
 * then a repeated start reuses a live session and a later start after session loss creates another
 * guest User. Actions then come from different guest Users. The full aggregate of the chain must be
 * [1,1,1,1,1], and a second browser's chain must stay separate.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a disposable local database, e.g.:
 *   INTEGRATION_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/clickmoji_race \
 *     npx vitest run src/lib/funnel.guest-chain.integration
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url || !isLocal)('guest funnel chain on PostgreSQL', () => {
  const guestId = `guest_pg17chain_${randomUUID()}`;
  const otherGuestId = `guest_pg17other_${randomUUID()}`;
  const createdUserIds: string[] = [];

  let prisma: typeof import('@/lib/prisma').prisma;
  let POST: typeof import('@/app/api/auth/guest/route').POST;
  let signGuestId: typeof import('./funnel').signGuestId;
  let FUNNEL_GUEST_COOKIE: typeof import('./funnel').FUNNEL_GUEST_COOKIE;
  let recordFunnelEvent: typeof import('./funnel').recordFunnelEvent;
  let FUNNEL_EVENT_REPORT_SELECT: typeof import('./funnel-analytics').FUNNEL_EVENT_REPORT_SELECT;
  let toFunnelEventRecords: typeof import('./funnel-analytics').toFunnelEventRecords;
  let aggregateFunnelWindow: typeof import('./funnel-analytics').aggregateFunnelWindow;

  const startRequest = (cookieGuestId: string) => {
    const signed = signGuestId(cookieGuestId);
    if (!signed) throw new Error('Auth secret missing for integration test');
    return new Request('http://localhost/api/auth/guest', {
      method: 'POST',
      headers: { cookie: `${FUNNEL_GUEST_COOKIE}=${encodeURIComponent(signed)}` },
    });
  };

  async function start(cookieGuestId: string): Promise<{ status: number; userId: string }> {
    const response = await POST(startRequest(cookieGuestId));
    const body = (await response.json()) as { user: { id: string } };
    createdUserIds.push(body.user.id);
    return { status: response.status, userId: body.user.id };
  }

  const chainRows = (ids: string[]) =>
    prisma.funnelEvent.findMany({
      where: { guestId: { in: ids } },
      select: FUNNEL_EVENT_REPORT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  beforeAll(async () => {
    ({ prisma } = await import('@/lib/prisma'));
    ({ POST } = await import('@/app/api/auth/guest/route'));
    ({ signGuestId, FUNNEL_GUEST_COOKIE, recordFunnelEvent } = await import('./funnel'));
    ({ FUNNEL_EVENT_REPORT_SELECT, toFunnelEventRecords, aggregateFunnelWindow } =
      await import('./funnel-analytics'));
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.funnelEvent.deleteMany({ where: { guestId: { in: [guestId, otherGuestId] } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('aggregates the full chain as [1,1,1,1,1] across concurrent, repeated and restarted guest Users', async () => {
    // The browser's visit comes first, as the proxy records it, then two concurrent starts with the
    // same cookie and no session: two guest Users.
    await recordFunnelEvent({ type: 'VISIT', userId: null, guestId });
    const raced = await Promise.all([start(guestId), start(guestId)]);
    expect(raced.map((result) => result.status)).toEqual([201, 201]);
    expect(new Set(raced.map((result) => result.userId)).size).toBe(2);

    // Repeated start while the session is still live: reuses that session's guest (no new User).
    doubles.auth.mockResolvedValueOnce({
      user: { id: raced[1].userId },
      sessionIssuedAt: Math.floor(Date.now() / 1000),
    });
    const repeated = await POST(startRequest(guestId));
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as { reused: boolean }).reused).toBe(true);

    // Session lost: a later start creates a third guest User from the same browser.
    const restarted = await start(guestId);
    expect(restarted.status).toBe(201);

    // Later actions come from the Users that did not write the milestones. Their timestamps are
    // kept strictly later than the milestones by a short pause, so the order is set by the test.
    await pause(5);
    await recordFunnelEvent({
      type: 'ITEM_ADD',
      userId: raced[0].userId,
      guestId,
    });
    await pause(5);
    await recordFunnelEvent({
      type: 'ITEM_PURCHASE',
      userId: restarted.userId,
      guestId,
    });

    // A second browser on the same database: its own visit and start, and nothing more.
    await recordFunnelEvent({ type: 'VISIT', userId: null, guestId: otherGuestId });
    const otherStart = await start(otherGuestId);

    const rows = await chainRows([guestId]);
    expect(rows.every((row) => row.guestId === guestId)).toBe(true);

    const itemAdd = rows.find((row) => row.type === 'ITEM_ADD');
    const itemPurchase = rows.find((row) => row.type === 'ITEM_PURCHASE');
    expect(itemAdd?.userId).toBe(raced[0].userId);
    expect(itemPurchase?.userId).toBe(restarted.userId);
    expect(rows.find((row) => row.type === 'REGISTER')).toBeDefined();
    expect(rows.find((row) => row.type === 'LIST_CREATE')).toBeDefined();

    const now = new Date(Date.now() + 60_000);
    const chain = aggregateFunnelWindow(toFunnelEventRecords(rows), 1, now);
    expect(chain.stages.map((stage) => stage.count)).toEqual([1, 1, 1, 1, 1]);
    expect(chain.overallRate).toBe(1);

    // Isolation: the other browser counts separately, and the two chains are not merged.
    const otherRows = await chainRows([otherGuestId]);
    expect(otherRows.every((row) => row.guestId === otherGuestId)).toBe(true);
    expect(otherStart.status).toBe(201);
    const otherChain = aggregateFunnelWindow(toFunnelEventRecords(otherRows), 1, now);
    expect(otherChain.stages.map((stage) => stage.count)).toEqual([1, 1, 1, 0, 0]);

    const both = aggregateFunnelWindow(
      toFunnelEventRecords(await chainRows([guestId, otherGuestId])),
      1,
      now
    );
    expect(both.stages.map((stage) => stage.count)).toEqual([2, 2, 2, 1, 1]);
  });
});
