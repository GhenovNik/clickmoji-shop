// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getTokenMock, findUserMock } = vi.hoisted(() => ({
  getTokenMock: vi.fn(),
  findUserMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: findUserMock } } }));

vi.mock('next-auth/jwt', () => ({ getToken: getTokenMock }));
vi.mock('@/lib/auth-security', () => ({
  checkRateLimit: async () => ({ allowed: true, resetAt: 0 }),
  getClientIp: () => '127.0.0.1',
  getRequestLocale: () => 'en',
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));
vi.mock('@/lib/funnel', () => ({
  FUNNEL_GUEST_COOKIE: 'guest',
  FUNNEL_GUEST_MAX_AGE_SECONDS: 60,
  mintGuestCredential: () => ({ guestId: 'g', cookieValue: 'v' }),
  recordFunnelEvent: async () => undefined,
  verifyGuestToken: () => 'g',
}));

import proxy from './proxy';

const NOW = Date.now();
const validToken = {
  id: 'user_current',
  sub: 'user_current',
  role: 'USER',
  sessionIssuedAt: Math.floor((NOW - 60_000) / 1000),
};
const legacyToken = {
  id: 'user_current',
  role: 'ADMIN',
  email: 'ada@example.com',
  iat: 1_700_000_000,
};

const get = (path: string) =>
  new NextRequest(`http://localhost${path}`, { headers: { accept: 'text/html' } });

const redirectLocation = (response: Response) => response.headers.get('location');

describe('proxy session handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUserMock.mockResolvedValue({
      createdAt: new Date(NOW - 120_000),
      role: 'USER',
      isGuest: false,
    });
    vi.stubEnv('PLAYWRIGHT_AUTH_BYPASS', '');
  });

  it('sends a protected page without a session to /login', async () => {
    getTokenMock.mockResolvedValue(null);

    const response = await proxy(get('/lists'));

    expect(redirectLocation(response)).toBe('http://localhost/login');
  });

  it('treats a legacy token without issuance time as signed out, so /lists goes to /login', async () => {
    getTokenMock.mockResolvedValue(legacyToken);

    const response = await proxy(get('/lists'));

    expect(redirectLocation(response)).toBe('http://localhost/login');
  });

  it('keeps /login and /register open when the token is legacy, with no redirect loop', async () => {
    getTokenMock.mockResolvedValue(legacyToken);

    expect(redirectLocation(await proxy(get('/login')))).toBeNull();
    expect(redirectLocation(await proxy(get('/register')))).toBeNull();
  });

  it('keeps /login open without any token', async () => {
    getTokenMock.mockResolvedValue(null);

    expect(redirectLocation(await proxy(get('/login')))).toBeNull();
  });

  it('sends a well-formed signed-in user away from /login to the homepage', async () => {
    getTokenMock.mockResolvedValue(validToken);

    const response = await proxy(get('/login'));

    expect(redirectLocation(response)).toBe('http://localhost/');
  });

  it('does not grant /admin to a legacy token, and sends a non-admin away from /admin', async () => {
    getTokenMock.mockResolvedValue(legacyToken);
    expect(redirectLocation(await proxy(get('/admin')))).toBe('http://localhost/login');

    getTokenMock.mockResolvedValue({ ...validToken, role: 'USER' });
    expect(redirectLocation(await proxy(get('/admin')))).toBe('http://localhost/');
  });

  it('allows login and blocks protected pages when the account was deleted', async () => {
    getTokenMock.mockResolvedValue({ ...validToken, role: 'ADMIN' });
    findUserMock.mockResolvedValue(null);

    expect(redirectLocation(await proxy(get('/login')))).toBeNull();
    expect(redirectLocation(await proxy(get('/admin')))).toBe('http://localhost/login');
  });

  it('uses the current role instead of the role in the token', async () => {
    getTokenMock.mockResolvedValue({ ...validToken, role: 'ADMIN' });

    expect(redirectLocation(await proxy(get('/admin')))).toBe('http://localhost/');
  });

  it('lets a current administrator into /admin', async () => {
    findUserMock.mockResolvedValue({ createdAt: new Date(NOW - 120_000), role: 'ADMIN' });
    getTokenMock.mockResolvedValue({ ...validToken, role: 'ADMIN' });

    expect(redirectLocation(await proxy(get('/admin')))).toBeNull();
  });
});

describe('proxy guest handling: the account row is canonical', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PLAYWRIGHT_AUTH_BYPASS', '');
  });

  it('sends a guest away from /admin even when the token names an administrator', async () => {
    getTokenMock.mockResolvedValue({ ...validToken, role: 'ADMIN', isGuest: false });
    findUserMock.mockResolvedValue({
      createdAt: new Date(NOW - 120_000),
      role: 'ADMIN',
      isGuest: true,
    });

    expect(redirectLocation(await proxy(get('/admin')))).toBe('http://localhost/');
  });

  it('keeps a guest on protected pages and out of the login redirect loop', async () => {
    getTokenMock.mockResolvedValue({ ...validToken, isGuest: true });
    findUserMock.mockResolvedValue({
      createdAt: new Date(NOW - 120_000),
      role: 'USER',
      isGuest: true,
    });

    expect(redirectLocation(await proxy(get('/lists')))).toBeNull();
    expect(redirectLocation(await proxy(get('/login')))).toBeNull();
    expect(redirectLocation(await proxy(get('/register')))).toBeNull();
  });

  it('signs out a superseded guest token whose row is now a registered account (AGE-1667)', async () => {
    getTokenMock.mockResolvedValue({ ...validToken, role: 'ADMIN', isGuest: true });
    findUserMock.mockResolvedValue({
      createdAt: new Date(NOW - 120_000),
      role: 'ADMIN',
      isGuest: false,
    });

    expect(redirectLocation(await proxy(get('/admin')))).toBe('http://localhost/login');
  });

  it('treats a token whose account row was deleted as signed out, even for a guest-looking token', async () => {
    getTokenMock.mockResolvedValue({ ...validToken, isGuest: true });
    findUserMock.mockResolvedValue(null);

    expect(redirectLocation(await proxy(get('/lists')))).toBe('http://localhost/login');
  });
});

describe('proxy and jwt agree on a promoted guest (AGE-1667)', () => {
  const promotedRow = { createdAt: new Date(NOW - 120_000), role: 'USER', isGuest: false };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PLAYWRIGHT_AUTH_BYPASS', '');
  });

  it('a stale guest token (minted before promotion, same id) cannot reach a protected page', async () => {
    // Issued after the row was created, so the issuance check alone accepts it (the old gap).
    getTokenMock.mockResolvedValue({ ...validToken, isGuest: true });
    findUserMock.mockResolvedValue(promotedRow);

    expect(redirectLocation(await proxy(get('/lists')))).toBe('http://localhost/login');
  });

  it('a stale guest token can still open the sign-in page, so the visitor can log in again', async () => {
    getTokenMock.mockResolvedValue({ ...validToken, isGuest: true });
    findUserMock.mockResolvedValue(promotedRow);

    expect(redirectLocation(await proxy(get('/login')))).toBeNull();
    expect(redirectLocation(await proxy(get('/register')))).toBeNull();
  });

  it('a fresh guest token for a live guest row still gets the guest session', async () => {
    getTokenMock.mockResolvedValue({ ...validToken, isGuest: true });
    findUserMock.mockResolvedValue({ ...promotedRow, isGuest: true });

    expect(redirectLocation(await proxy(get('/lists')))).toBeNull();
    // A live guest may visit the sign-in page; only an account is sent home from it.
    expect(redirectLocation(await proxy(get('/login')))).toBeNull();
  });

  it('an ordinary token for an ordinary row is unchanged: sign-in page redirects home', async () => {
    getTokenMock.mockResolvedValue({ ...validToken, isGuest: false });
    findUserMock.mockResolvedValue(promotedRow);

    expect(redirectLocation(await proxy(get('/login')))).toBe('http://localhost/');
  });
});
