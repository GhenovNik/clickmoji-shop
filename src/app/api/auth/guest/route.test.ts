// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decode } from 'next-auth/jwt';

const doubles = vi.hoisted(() => ({
  auth: vi.fn(),
  findUniqueUser: vi.fn(),
  createUser: vi.fn(),
  updateManyUser: vi.fn(),
  createManyLists: vi.fn(),
  funnelCreate: vi.fn(),
  funnelUpdateMany: vi.fn(),
  funnelFindFirst: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: doubles.auth,
}));

vi.mock('@/lib/prisma', () => {
  const prisma = {
    user: {
      findUnique: doubles.findUniqueUser,
      create: doubles.createUser,
      updateMany: doubles.updateManyUser,
    },
    list: {
      createMany: doubles.createManyLists,
    },
    funnelEvent: {
      create: doubles.funnelCreate,
      updateMany: doubles.funnelUpdateMany,
      findFirst: doubles.funnelFindFirst,
    },
    // Advisory lock taken before the once-per-guest milestone check (funnel.ts).
    $executeRaw: async () => 0,
    $transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(prisma),
  };
  return { prisma };
});

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return {
    ...actual,
    checkRateLimit: doubles.checkRateLimit,
  };
});

const { POST } = await import('./route');
const { FUNNEL_GUEST_COOKIE, signGuestId } = await import('@/lib/funnel');
const { isGuestEmail, NEXTAUTH_SECURE_SESSION_COOKIE, NEXTAUTH_SESSION_COOKIE } =
  await import('@/lib/guest');

const TEST_SECRET = 'test-auth-secret-for-guest-session';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.AUTH_SECRET = TEST_SECRET;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.NEXTAUTH_URL;
  delete process.env.AUTH_URL;
  delete process.env.VERCEL;

  doubles.auth.mockReset().mockResolvedValue(null);
  doubles.findUniqueUser.mockReset().mockResolvedValue(null);
  doubles.createUser
    .mockReset()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'guest-user-1',
      email: data.email,
      name: data.name ?? null,
      image: null,
      role: data.role ?? 'USER',
      isGuest: data.isGuest ?? true,
    }));
  doubles.updateManyUser.mockReset().mockResolvedValue({ count: 1 });
  doubles.createManyLists.mockReset().mockResolvedValue({ count: 5 });
  doubles.funnelCreate.mockReset().mockResolvedValue({ id: 'evt-1' });
  doubles.funnelUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  doubles.funnelFindFirst.mockReset().mockResolvedValue(null);
  doubles.checkRateLimit
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 19, resetAt: 0 });
});

describe('POST /api/auth/guest', () => {
  it('creates a User-backed guest account, starter lists, funnel events, and NextAuth session cookie', async () => {
    const visitGuestId = 'guest_visit_1234567890';
    const signedVisitCookie = signGuestId(visitGuestId);

    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', {
        method: 'POST',
        headers: {
          cookie: `NEXT_LOCALE=ru; ${FUNNEL_GUEST_COOKIE}=${signedVisitCookie}`,
        },
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      user: { id: 'guest-user-1', role: 'USER', isGuest: true },
    });

    const createData = doubles.createUser.mock.calls[0]?.[0]?.data as {
      email: string;
      password: null;
      role: string;
      emailVerified: null;
      isGuest: boolean;
      createdAt: Date;
      guestLastActiveAt: Date;
    };
    expect(isGuestEmail(createData.email)).toBe(true);
    expect(createData.password).toBeNull();
    expect(createData.role).toBe('USER');
    expect(createData.emailVerified).toBeNull();
    expect(createData.isGuest).toBe(true);
    expect(createData.createdAt).toBeInstanceOf(Date);
    expect(createData.guestLastActiveAt).toEqual(createData.createdAt);

    expect(doubles.createManyLists).toHaveBeenCalledWith({
      data: [
        { name: 'Основной', isActive: true, userId: 'guest-user-1' },
        { name: 'На выходные', isActive: false, userId: 'guest-user-1' },
        { name: 'Праздники', isActive: false, userId: 'guest-user-1' },
        { name: 'Для вечеринки', isActive: false, userId: 'guest-user-1' },
        { name: 'Срочное', isActive: false, userId: 'guest-user-1' },
      ],
    });

    expect(doubles.funnelCreate.mock.calls.map(([arg]) => arg.data)).toEqual([
      { type: 'REGISTER', userId: 'guest-user-1', guestId: visitGuestId },
      { type: 'LIST_CREATE', userId: 'guest-user-1', guestId: visitGuestId },
    ]);
    expect(doubles.funnelUpdateMany).toHaveBeenCalledWith({
      where: { guestId: visitGuestId, userId: null },
      data: { userId: 'guest-user-1' },
    });

    const setCookieHeader = response.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain(`${NEXTAUTH_SESSION_COOKIE}=`);
    const cookieMatch = setCookieHeader.match(new RegExp(`${NEXTAUTH_SESSION_COOKIE}=([^;]+)`));
    expect(cookieMatch?.[1]).toBeTruthy();

    const decoded = await decode({ token: cookieMatch![1], secret: TEST_SECRET });
    expect(decoded).toMatchObject({
      id: 'guest-user-1',
      role: 'USER',
      email: createData.email,
      isGuest: true,
      sub: 'guest-user-1',
    });
    expect(typeof decoded?.iat).toBe('number');
    expect(decoded!.iat as number).toBeGreaterThanOrEqual(
      Math.floor(createData.createdAt.getTime() / 1000)
    );
  });

  it('creates English starter lists when NEXT_LOCALE=en and ignores forged funnel cookies', async () => {
    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', {
        method: 'POST',
        headers: {
          cookie: `NEXT_LOCALE=en; ${FUNNEL_GUEST_COOKIE}=forged_guest_1234567890`,
        },
      })
    );

    expect(response.status).toBe(201);
    expect(doubles.createManyLists).toHaveBeenCalledWith({
      data: [
        { name: 'Main', isActive: true, userId: 'guest-user-1' },
        { name: 'Weekend', isActive: false, userId: 'guest-user-1' },
        { name: 'Holidays', isActive: false, userId: 'guest-user-1' },
        { name: 'Party', isActive: false, userId: 'guest-user-1' },
        { name: 'Urgent', isActive: false, userId: 'guest-user-1' },
      ],
    });
    expect(doubles.funnelCreate.mock.calls.map(([arg]) => arg.data)).toEqual([
      { type: 'REGISTER', userId: 'guest-user-1', guestId: null },
      { type: 'LIST_CREATE', userId: 'guest-user-1', guestId: null },
    ]);
  });

  it('uses __Secure- session cookie when configured for HTTPS', async () => {
    process.env.NEXTAUTH_URL = 'https://clickmoji.example.com';

    const response = await POST(
      new Request('https://clickmoji.example.com/api/auth/guest', { method: 'POST' })
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie') ?? '').toContain(
      `${NEXTAUTH_SECURE_SESSION_COOKIE}=`
    );
  });

  it('reuses an existing active guest session without minting a second guest', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    doubles.auth.mockResolvedValue({
      sessionIssuedAt: nowSec,
      user: { id: 'existing-guest', role: 'USER', isGuest: true },
    });
    doubles.findUniqueUser.mockResolvedValue({
      id: 'existing-guest',
      role: 'USER',
      isGuest: true,
      createdAt: new Date(nowSec * 1000),
    });

    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST' })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { id: 'existing-guest', role: 'USER', isGuest: true },
      reused: true,
    });
    expect(doubles.createUser).not.toHaveBeenCalled();
    expect(doubles.updateManyUser).toHaveBeenCalledWith({
      where: { id: 'existing-guest', isGuest: true },
      data: { guestLastActiveAt: expect.any(Date) },
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('records REGISTER and LIST_CREATE once per funnel guestId when the same browser starts again', async () => {
    const recorded = new Set<string>();
    doubles.funnelFindFirst.mockImplementation(
      async ({ where }: { where: { type: string; guestId: string } }) =>
        recorded.has(`${where.type}:${where.guestId}`) ? { id: 'evt-existing' } : null
    );
    doubles.funnelCreate.mockImplementation(
      async ({ data }: { data: { type: string; guestId: string | null } }) => {
        if (data.guestId) recorded.add(`${data.type}:${data.guestId}`);
        return { id: 'evt' };
      }
    );

    const guestId = 'guest-dedupe-0000000001';
    const cookie = `${FUNNEL_GUEST_COOKIE}=${signGuestId(guestId) ?? ''}`;
    const first = await POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST', headers: { cookie } })
    );
    const second = await POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST', headers: { cookie } })
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const createdTypes = doubles.funnelCreate.mock.calls.map(
      (call: unknown[]) => (call[0] as { data: { type: string } }).data.type
    );
    expect(createdTypes.filter((type) => type === 'REGISTER')).toHaveLength(1);
    expect(createdTypes.filter((type) => type === 'LIST_CREATE')).toHaveLength(1);
    // Correlation still attaches each new guest User.id to the funnel guestId.
    expect(doubles.funnelUpdateMany).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite an existing regular user session', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    doubles.auth.mockResolvedValue({
      sessionIssuedAt: nowSec,
      user: { id: 'regular-user', role: 'USER', isGuest: false },
    });
    doubles.findUniqueUser.mockResolvedValue({
      id: 'regular-user',
      role: 'USER',
      isGuest: false,
      createdAt: new Date(nowSec * 1000),
    });

    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST' })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { id: 'regular-user', role: 'USER', isGuest: false },
      reused: true,
    });
    expect(doubles.createUser).not.toHaveBeenCalled();
    expect(doubles.updateManyUser).not.toHaveBeenCalled();
  });

  it('creates a new guest when an old session references a deleted guest row', async () => {
    doubles.auth.mockResolvedValue({
      sessionIssuedAt: Math.floor(Date.now() / 1000),
      user: { id: 'deleted-guest', role: 'USER', isGuest: true },
    });
    doubles.findUniqueUser.mockResolvedValue(null);

    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST' })
    );

    expect(response.status).toBe(201);
    expect(doubles.createUser).toHaveBeenCalledTimes(1);
  });

  it('enforces IP rate limit to prevent guest account churn', async () => {
    doubles.checkRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', {
        method: 'POST',
        headers: { cookie: 'NEXT_LOCALE=en', 'x-forwarded-for': '203.0.113.10' },
      })
    );

    expect(response.status).toBe(429);
    expect(doubles.createUser).not.toHaveBeenCalled();
    expect(doubles.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'auth:guest:ip:203.0.113.10' })
    );
  });

  it('fails closed with 500 and creates no user when auth secret is missing', async () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;

    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', {
        method: 'POST',
        headers: { cookie: 'NEXT_LOCALE=en' },
      })
    );

    expect(response.status).toBe(500);
    expect(doubles.createUser).not.toHaveBeenCalled();
  });

  it('preserves 201 guest creation when funnel event persistence fails', async () => {
    doubles.funnelCreate.mockRejectedValue(new Error('funnel down'));

    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST' })
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain(`${NEXTAUTH_SESSION_COOKIE}=`);
  });
});

describe('POST /api/auth/guest session claims', () => {
  it('stamps the new guest token with the immutable issuance claim equal to the row creation second', async () => {
    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST' })
    );
    expect(response.status).toBe(201);

    const createData = doubles.createUser.mock.calls[0]?.[0]?.data as { createdAt: Date };
    const cookieMatch = (response.headers.get('set-cookie') ?? '').match(
      new RegExp(`${NEXTAUTH_SESSION_COOKIE}=([^;]+)`)
    );
    const decoded = await decode({ token: cookieMatch![1], secret: TEST_SECRET });
    expect(decoded?.sessionIssuedAt).toBe(Math.floor(createData.createdAt.getTime() / 1000));
  });

  it('does not reuse a legacy session that carries only the standard iat (reauth required)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    doubles.auth.mockResolvedValue({
      tokenIssuedAt: nowSec,
      sessionIssuedAt: undefined,
      user: { id: 'legacy-guest', role: 'USER', isGuest: true },
    });
    doubles.findUniqueUser.mockResolvedValue({
      id: 'legacy-guest',
      role: 'USER',
      isGuest: true,
      createdAt: new Date((nowSec - 60) * 1000),
    });

    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST' })
    );

    expect(response.status).toBe(201);
    expect(doubles.createUser).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a session whose issuance claim predates the row it names', async () => {
    const createdAt = new Date('2026-11-25T10:00:05.000Z');
    doubles.auth.mockResolvedValue({
      sessionIssuedAt: Math.floor(createdAt.getTime() / 1000) - 1,
      user: { id: 'recreated-guest', role: 'USER', isGuest: true },
    });
    doubles.findUniqueUser.mockResolvedValue({
      id: 'recreated-guest',
      role: 'USER',
      isGuest: true,
      createdAt,
    });

    const response = await POST(
      new Request('http://localhost:3000/api/auth/guest', { method: 'POST' })
    );

    expect(response.status).toBe(201);
    expect(doubles.createUser).toHaveBeenCalledTimes(1);
  });
});
