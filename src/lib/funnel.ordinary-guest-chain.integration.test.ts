// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Real-PostgreSQL check of an ordinary registration that happens in the same browser as a guest
 * funnel chain. The browser first gets a VISIT, then registers an account with its signed funnel
 * cookie (real `POST /api/auth/register`). Later, the session is gone and the guest Start reuses the
 * same signed cookie (real `POST /api/auth/guest`). The ordinary milestones must not block the
 * guest's REGISTER and LIST_CREATE, a repeated guest Start must still add nothing, and the full
 * aggregate must be [2,2,2,1,1]: the ordinary chain stops at LIST_CREATE, the guest chain reaches
 * the purchase.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a disposable local database, e.g.:
 *   INTEGRATION_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/clickmoji_chain \
 *     npx vitest run src/lib/funnel.ordinary-guest-chain.integration
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

vi.mock('@/lib/email', () => ({
  // Verification is off and no mail is sent, so the register route never leaves the machine.
  isEmailVerificationRequired: () => false,
  sendVerificationEmail: async () => undefined,
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return {
    ...actual,
    checkRateLimit: async () => ({ allowed: true, resetAt: 0 }),
  };
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url || !isLocal)('ordinary registration then guest start on PostgreSQL', () => {
  const guestId = `guest_pg17ord_${randomUUID()}`;
  const email = `ordinary-${randomUUID()}@example.test`;
  const createdUserIds: string[] = [];

  let prisma: typeof import('@/lib/prisma').prisma;
  let REGISTER: typeof import('@/app/api/auth/register/route').POST;
  let GUEST_START: typeof import('@/app/api/auth/guest/route').POST;
  let signGuestId: typeof import('./funnel').signGuestId;
  let FUNNEL_GUEST_COOKIE: typeof import('./funnel').FUNNEL_GUEST_COOKIE;
  let recordFunnelEvent: typeof import('./funnel').recordFunnelEvent;
  let FUNNEL_EVENT_REPORT_SELECT: typeof import('./funnel-analytics').FUNNEL_EVENT_REPORT_SELECT;
  let toFunnelEventRecords: typeof import('./funnel-analytics').toFunnelEventRecords;
  let aggregateFunnelWindow: typeof import('./funnel-analytics').aggregateFunnelWindow;

  /** The browser's signed funnel cookie, as the proxy sets it. Never a client-chosen value. */
  const browserCookie = () => {
    const signed = signGuestId(guestId);
    if (!signed) throw new Error('Auth secret missing for integration test');
    return `${FUNNEL_GUEST_COOKIE}=${encodeURIComponent(signed)}`;
  };

  const registerRequest = () =>
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { cookie: browserCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Ordinary-Pass-2026', name: null }),
    });

  const guestStartRequest = () =>
    new Request('http://localhost/api/auth/guest', {
      method: 'POST',
      headers: { cookie: browserCookie() },
    });

  const chainRows = () =>
    prisma.funnelEvent.findMany({
      where: { guestId },
      select: FUNNEL_EVENT_REPORT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  beforeAll(async () => {
    ({ prisma } = await import('@/lib/prisma'));
    ({ POST: REGISTER } = await import('@/app/api/auth/register/route'));
    ({ POST: GUEST_START } = await import('@/app/api/auth/guest/route'));
    ({ signGuestId, FUNNEL_GUEST_COOKIE, recordFunnelEvent } = await import('./funnel'));
    ({ FUNNEL_EVENT_REPORT_SELECT, toFunnelEventRecords, aggregateFunnelWindow } =
      await import('./funnel-analytics'));
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.funnelEvent.deleteMany({ where: { guestId } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('aggregates the ordinary chain and the guest chain as [2,2,2,1,1] with the same signed cookie', async () => {
    // The proxy records the visit before any account exists.
    await recordFunnelEvent({ type: 'VISIT', userId: null, guestId });
    await pause(5);

    // Ordinary registration with the signed cookie: REGISTER and LIST_CREATE for the ordinary User.
    doubles.auth.mockResolvedValue(null);
    const registered = await REGISTER(registerRequest());
    expect(registered.status).toBe(201);
    const ordinaryUserId = ((await registered.json()) as { user: { id: string } }).user.id;
    createdUserIds.push(ordinaryUserId);
    await pause(5);

    // Session lost: the browser loads an entry page anonymously (the proxy's VISIT, no User), so the
    // guest chain has its own first stage. The earlier VISIT stays with the ordinary chain.
    await recordFunnelEvent({ type: 'VISIT', userId: null, guestId });
    await pause(5);

    // The guest Start reuses the prior signed cookie and creates a guest User.
    const started = await GUEST_START(guestStartRequest());
    expect(started.status).toBe(201);
    const guestUserId = ((await started.json()) as { user: { id: string } }).user.id;
    createdUserIds.push(guestUserId);
    await pause(5);

    // The guest's later actions, each strictly after the milestones, from the guest User.
    await recordFunnelEvent({ type: 'ITEM_ADD', userId: guestUserId, guestId });
    await pause(5);
    await recordFunnelEvent({ type: 'ITEM_PURCHASE', userId: guestUserId, guestId });
    await pause(5);

    // A repeated guest Start from the same browser adds no milestone: its guest User is new, but
    // the guest chain already has its REGISTER and LIST_CREATE.
    const repeated = await GUEST_START(guestStartRequest());
    expect(repeated.status).toBe(201);
    createdUserIds.push(((await repeated.json()) as { user: { id: string } }).user.id);

    const rows = await chainRows();
    const registers = rows.filter((row) => row.type === 'REGISTER');
    const listCreates = rows.filter((row) => row.type === 'LIST_CREATE');
    expect(registers.map((row) => row.userId).sort()).toEqual([ordinaryUserId, guestUserId].sort());
    expect(listCreates.map((row) => row.userId).sort()).toEqual(
      [ordinaryUserId, guestUserId].sort()
    );

    const now = new Date(Date.now() + 60_000);
    const chain = aggregateFunnelWindow(toFunnelEventRecords(rows), 1, now);
    expect(chain.stages.map((stage) => stage.count)).toEqual([2, 2, 2, 1, 1]);
    expect(chain.overallRate).toBe(0.5);
  });
});
