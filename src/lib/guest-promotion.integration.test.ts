// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Real-PostgreSQL check of in-place guest promotion (AGE-1667): the real register route, the real
 * conditional update, unique email, cleanup protection and the replaced session.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a disposable local database, e.g.:
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:…@127.0.0.1:<port>/clickmoji_race \
 *     npx vitest run src/lib/guest-promotion.integration
 * The URL is refused unless it names localhost, so no shared or production database can be used.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const isLocal = url ? ['localhost', '127.0.0.1'].includes(new URL(url).hostname) : false;
const SECRET = `integration-${randomUUID()}`;

if (url && isLocal) {
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET = SECRET;
  delete process.env.NEXTAUTH_SECRET;
}

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));
vi.mock('@/lib/email', () => ({
  isEmailVerificationRequired: () => false,
  sendVerificationEmail: async () => undefined,
}));
vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 99, resetAt: 0 }) };
});

const RACERS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!url || !isLocal)('guest promotion on PostgreSQL', () => {
  const tag = `promo-${randomUUID()}`;
  const createdIds: string[] = [];
  let prisma: import('@prisma/client').PrismaClient;
  let POST: (request: Request) => Promise<Response>;
  let encode: typeof import('next-auth/jwt').encode;
  let inactiveGuestWhere: typeof import('./guest-cleanup').inactiveGuestWhere;
  let protectGuestForRegistration: typeof import('./guest-promotion').protectGuestForRegistration;
  let signGuestId: typeof import('./funnel').signGuestId;

  async function insertGuest(label: string, lastActive: Date) {
    const row = await prisma.user.create({
      data: {
        email: `guest_${randomUUID()}@guest.clickmoji.invalid`,
        isGuest: true,
        role: 'USER',
        createdAt: lastActive,
        guestLastActiveAt: lastActive,
        name: label,
      },
      select: { id: true },
    });
    createdIds.push(row.id);
    await prisma.list.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({
        name: `${label}-${index}`,
        userId: row.id,
        isActive: index === 0,
      })),
    });
    return row.id;
  }

  async function guestCookie(userId: string, funnelGuest: string) {
    const createdAt = (
      await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } })
    ).createdAt;
    const token = await encode({
      token: {
        id: userId,
        sub: userId,
        role: 'USER',
        email: 'guest',
        isGuest: true,
        sessionIssuedAt: Math.floor(createdAt.getTime() / 1000),
      },
      secret: SECRET,
      maxAge: 60,
    });
    const funnel = signGuestId(funnelGuest);
    return `NEXT_LOCALE=en; next-auth.session-token=${token}; clickmoji_funnel_guest=${encodeURIComponent(
      funnel ?? ''
    )}`;
  }

  function register(email: string, cookie: string | null) {
    return POST(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({ email, password: 'password1', name: 'Racer' }),
      })
    );
  }

  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    const { createPrismaPgAdapter } = await import('./prisma-adapter');
    prisma = new PrismaClient({ adapter: createPrismaPgAdapter(url!) });
    ({ POST } = await import('@/app/api/auth/register/route'));
    ({ encode } = await import('next-auth/jwt'));
    ({ inactiveGuestWhere } = await import('./guest-cleanup'));
    ({ protectGuestForRegistration } = await import('./guest-promotion'));
    ({ signGuestId } = await import('./funnel'));
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.funnelEvent.deleteMany({ where: { userId: { in: createdIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
      await prisma.$disconnect();
    }
  });

  it('eight simultaneous registrations of one guest yield one account with the same id', async () => {
    const guestId = await insertGuest('racer', new Date());
    const cookie = await guestCookie(guestId, `funnel-${tag}-a`);

    const responses = await Promise.all(
      Array.from({ length: RACERS }, (_, index) =>
        register(`racer-${index}-${tag}@example.test`, cookie)
      )
    );
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(RACERS - 1);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: guestId },
      select: { isGuest: true, email: true, name: true },
    });
    expect(row).toMatchObject({ isGuest: false, name: 'Racer' });
    expect(row.email).toContain(`-${tag}@example.test`);
    expect(await prisma.list.count({ where: { userId: guestId } })).toBe(5);

    const promotions = await prisma.funnelEvent.count({
      where: { userId: guestId, type: 'GUEST_REGISTERED', guestId: `funnel-${tag}-a` },
    });
    expect(promotions).toBe(1);
  });

  it('two guests racing for one email: one account, the other guest keeps its placeholder', async () => {
    const first = await insertGuest('dup-first', new Date());
    const second = await insertGuest('dup-second', new Date());
    const email = `dup-${tag}@example.test`;

    const [a, b] = await Promise.all([
      register(email, await guestCookie(first, `funnel-${tag}-b`)),
      register(email, await guestCookie(second, `funnel-${tag}-c`)),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 400]);
    const rows = await prisma.user.findMany({
      where: { id: { in: [first, second] } },
      select: { id: true, isGuest: true },
    });
    expect(rows.filter((row) => !row.isGuest)).toHaveLength(1);
    expect(rows.filter((row) => row.isGuest)).toHaveLength(1);
  });

  it('cleanup keeps a guest whose registration has begun, even when it was long inactive', async () => {
    const guestId = await insertGuest('idle', new Date(Date.now() - 90 * DAY_MS));
    await prisma.user.update({
      where: { id: guestId },
      data: { guestLastActiveAt: new Date(Date.now() - 90 * DAY_MS) },
    });

    // Registration starts: the guest is marked active before any slow step.
    expect(await protectGuestForRegistration(guestId)).toBe(true);

    const cutoff = new Date(Date.now() - 30 * DAY_MS);
    const removed = await prisma.user.deleteMany({
      where: { id: guestId, ...inactiveGuestWhere(cutoff) },
    });
    expect(removed.count).toBe(0);
    expect(await prisma.user.count({ where: { id: guestId } })).toBe(1);
  });

  it('a guest idle past the cutoff, with no registration, is still cleaned up', async () => {
    const guestId = await insertGuest('stale', new Date(Date.now() - 90 * DAY_MS));

    const removed = await prisma.user.deleteMany({
      where: { id: guestId, ...inactiveGuestWhere(new Date(Date.now() - 30 * DAY_MS)) },
    });

    expect(removed.count).toBe(1);
  });

  it('after promotion the same id is no longer eligible for guest cleanup', async () => {
    const guestId = await insertGuest('promoted-idle', new Date(Date.now() - 90 * DAY_MS));
    const response = await register(
      `idle-${tag}@example.test`,
      await guestCookie(guestId, `funnel-${tag}-d`)
    );
    expect(response.status).toBe(201);

    const removed = await prisma.user.deleteMany({
      where: { id: guestId, ...inactiveGuestWhere(new Date(Date.now() - 30 * DAY_MS)) },
    });

    expect(removed.count).toBe(0);
  });

  it('keeps the guest lists and their owner after promotion', async () => {
    const guestId = await insertGuest('kept', new Date());
    const before = await prisma.list.findMany({
      where: { userId: guestId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    const response = await register(
      `kept-${tag}@example.test`,
      await guestCookie(guestId, `funnel-${tag}-e`)
    );
    const after = await prisma.list.findMany({
      where: { userId: guestId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    expect(response.status).toBe(201);
    expect(after).toEqual(before);
    expect(
      await prisma.list.count({
        where: { userId: { not: guestId }, name: { startsWith: 'kept-' } },
      })
    ).toBe(0);
  });
});
