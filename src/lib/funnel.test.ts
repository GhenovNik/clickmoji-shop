// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { aggregateFunnelWindow, type FunnelEventRecord } from './funnel-analytics';

const doubles = vi.hoisted(() => ({
  funnelCreate: vi.fn(),
  funnelUpdateMany: vi.fn(),
  headerMap: new Map<string, string>(),
  cookieMap: new Map<string, string>(),
  auth: vi.fn(),
  getToken: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: async () => ({ createdAt: new Date(0), role: 'USER' }) },
    get funnelEvent() {
      return {
        create: doubles.funnelCreate,
        updateMany: doubles.funnelUpdateMany,
      };
    },
  },
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => doubles.headerMap.get(name.toLowerCase()) ?? null,
  }),
  cookies: async () => ({
    get: (name: string) => {
      const value = doubles.cookieMap.get(name);
      return value !== undefined ? { value } : undefined;
    },
  }),
}));

vi.mock('@/lib/auth', () => ({
  auth: doubles.auth,
}));

vi.mock('next-auth/jwt', () => ({
  getToken: doubles.getToken,
}));

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ru',
  getTranslations: async () => {
    const t = (key: string) => key;
    t.rich = (key: string) => key;
    return t;
  },
}));

vi.mock('@/components/ui/InteractiveCart', () => ({
  default: () => null,
}));

const {
  FUNNEL_GUEST_COOKIE,
  getGuestIdFromCookieHeader,
  getGuestIdFromRequest,
  readGuestIdFromRequestScope,
  recordFunnelEvent,
  sanitizeGuestId,
  signGuestId,
  verifyGuestToken,
} = await import('./funnel');
const { default: proxy } = await import('@/proxy');
const { default: Home } = await import('@/app/page');

// Internal forwarding header name that an external client could try to spoof.
const SPOOFABLE_HEADER = 'x-clickmoji-funnel-guest';
const TEST_SECRET = 'test-auth-secret-for-funnel-tests';
const GUEST_ID = 'guest_1234567890abcdef';

beforeEach(() => {
  process.env.AUTH_SECRET = TEST_SECRET;
  delete process.env.NEXTAUTH_SECRET;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  doubles.funnelCreate.mockReset().mockResolvedValue({ id: 'evt-1' });
  doubles.funnelUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  doubles.headerMap.clear();
  doubles.cookieMap.clear();
  doubles.auth.mockReset().mockResolvedValue(null);
  doubles.getToken.mockReset().mockResolvedValue(null);
});

describe('funnel guest identity trust boundary', () => {
  it('accepts valid opaque guest IDs and rejects invalid or oversized values', () => {
    expect(sanitizeGuestId('guest_1234567890abcdef')).toBe('guest_1234567890abcdef');
    expect(sanitizeGuestId('too-short')).toBeNull();
    expect(sanitizeGuestId('invalid$chars!1234567890')).toBeNull();
    expect(sanitizeGuestId('a'.repeat(65))).toBeNull();
    expect(sanitizeGuestId(null)).toBeNull();
  });

  it('verifies only server-signed guest tokens', () => {
    const token = signGuestId(GUEST_ID);
    expect(token).toMatch(/^guest_1234567890abcdef\./);
    expect(verifyGuestToken(token)).toBe(GUEST_ID);

    // Unsigned, forged-signature, and signature-for-another-ID values are all rejected.
    expect(verifyGuestToken(GUEST_ID)).toBeNull();
    expect(verifyGuestToken(`${GUEST_ID}.forged-signature`)).toBeNull();
    expect(verifyGuestToken(`${GUEST_ID}.${token?.split('.')[1]}x`)).toBeNull();
    expect(verifyGuestToken(`guest_abcdef1234567890.${token?.split('.')[1]}`)).toBeNull();
    expect(verifyGuestToken(undefined)).toBeNull();
  });

  it('rejects every guest token when no auth secret is configured (fails closed)', () => {
    const token = signGuestId(GUEST_ID);
    delete process.env.AUTH_SECRET;
    expect(verifyGuestToken(token)).toBeNull();
    expect(signGuestId(GUEST_ID)).toBeNull();
  });

  it('rejects tokens signed with a different secret', () => {
    const token = signGuestId(GUEST_ID);
    process.env.AUTH_SECRET = 'rotated-or-foreign-secret';
    expect(verifyGuestToken(token)).toBeNull();
  });

  it('reads guest identity from a verified cookie only, ignoring a spoofed internal header', () => {
    const signed = signGuestId(GUEST_ID);

    const withSignedCookie = new Request('http://localhost/api/lists', {
      headers: { cookie: `other=1; ${FUNNEL_GUEST_COOKIE}=${signed}` },
    });
    expect(getGuestIdFromRequest(withSignedCookie)).toBe(GUEST_ID);

    const forgedCookie = new Request('http://localhost/api/lists', {
      headers: { cookie: `${FUNNEL_GUEST_COOKIE}=guest_abcdef1234567890` },
    });
    expect(getGuestIdFromRequest(forgedCookie)).toBeNull();
    expect(getGuestIdFromCookieHeader(`${FUNNEL_GUEST_COOKIE}=bad`)).toBeNull();

    const spoofedHeader = new Request('http://localhost/api/auth/callback/credentials', {
      headers: { [SPOOFABLE_HEADER]: signed ?? '' },
    });
    expect(getGuestIdFromRequest(spoofedHeader)).toBeNull();
  });

  it('ignores a spoofed internal header and forged cookie in the request scope', async () => {
    const signed = signGuestId(GUEST_ID);
    doubles.headerMap.set(SPOOFABLE_HEADER, signed ?? '');
    doubles.cookieMap.set(FUNNEL_GUEST_COOKIE, 'guest_forged_1234567890');

    expect(await readGuestIdFromRequestScope()).toBeNull();

    doubles.cookieMap.set(FUNNEL_GUEST_COOKIE, signed ?? '');
    expect(await readGuestIdFromRequestScope()).toBe(GUEST_ID);
  });

  it('forged header or cookie cannot write or reassign identity on a login event', async () => {
    doubles.headerMap.set(SPOOFABLE_HEADER, 'guest_victim_1234567890');
    doubles.cookieMap.set(FUNNEL_GUEST_COOKIE, 'guest_victim_1234567890');

    const guestId = await readGuestIdFromRequestScope();
    await recordFunnelEvent({
      type: 'LOGIN',
      userId: 'user-attacker',
      guestId,
      correlateGuest: true,
    });

    expect(guestId).toBeNull();
    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: { type: 'LOGIN', userId: 'user-attacker', guestId: null },
    });
    expect(doubles.funnelUpdateMany).not.toHaveBeenCalled();
  });
});

describe('recordFunnelEvent', () => {
  it('stores only event type and opaque IDs, and correlates anonymous guest rows on auth', async () => {
    const ok = await recordFunnelEvent({
      type: 'REGISTER',
      userId: 'user-123',
      guestId: GUEST_ID,
      correlateGuest: true,
    });

    expect(ok).toBe(true);
    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: {
        type: 'REGISTER',
        userId: 'user-123',
        guestId: GUEST_ID,
      },
    });
    expect(doubles.funnelUpdateMany).toHaveBeenCalledWith({
      where: {
        guestId: GUEST_ID,
        userId: null,
      },
      data: {
        userId: 'user-123',
      },
    });
  });

  it('skips database writes when both userId and valid guestId are missing', async () => {
    const ok = await recordFunnelEvent({
      type: 'VISIT',
      userId: null,
      guestId: 'invalid',
    });

    expect(ok).toBe(false);
    expect(doubles.funnelCreate).not.toHaveBeenCalled();
  });

  it('isolates write failures and logs without PII or private payloads', async () => {
    const consoleSpy = vi.mocked(console.error);
    doubles.funnelCreate.mockRejectedValue(
      new Error('Connection failed for secret-user-email@example.com')
    );
    doubles.funnelUpdateMany.mockRejectedValue({ code: 'P1001' });

    const ok = await recordFunnelEvent({
      type: 'LOGIN',
      userId: 'secret-user-id-999',
      guestId: 'guest_secret_1234567890',
      correlateGuest: true,
    });

    expect(ok).toBe(false);
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    const loggedText = JSON.stringify(consoleSpy.mock.calls);
    expect(loggedText).not.toContain('secret-user-id-999');
    expect(loggedText).not.toContain('guest_secret_1234567890');
    expect(loggedText).not.toContain('secret-user-email@example.com');
  });
});

describe('direct entry visit tracking (proxy)', () => {
  const ENTRY_PATHS = [
    'http://localhost/',
    'http://localhost/login',
    'http://localhost/register',
    'http://localhost/categories',
    'http://localhost/categories/cat-1/products',
  ];

  it.each(ENTRY_PATHS)(
    'mints a signed guest cookie and records VISIT on direct %s',
    async (url) => {
      const response = await proxy(new NextRequest(url));

      const setCookie = response.cookies.get(FUNNEL_GUEST_COOKIE)?.value;
      const guestId = verifyGuestToken(setCookie);
      expect(guestId).toBeTruthy();
      expect(doubles.funnelCreate).toHaveBeenCalledWith({
        data: { type: 'VISIT', userId: null, guestId },
      });
    }
  );

  it('preserves a verified guest cookie without rotating it and records VISIT under it', async () => {
    const signed = signGuestId(GUEST_ID) ?? '';
    const response = await proxy(
      new NextRequest('http://localhost/categories', {
        headers: { cookie: `${FUNNEL_GUEST_COOKIE}=${signed}` },
      })
    );

    expect(response.cookies.get(FUNNEL_GUEST_COOKIE)).toBeUndefined();
    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: { type: 'VISIT', userId: null, guestId: GUEST_ID },
    });
  });

  it('replaces a forged guest cookie with a fresh signed one and never records the forged ID', async () => {
    const response = await proxy(
      new NextRequest('http://localhost/login', {
        headers: { cookie: `${FUNNEL_GUEST_COOKIE}=guest_forged_1234567890` },
      })
    );

    const setCookie = response.cookies.get(FUNNEL_GUEST_COOKIE)?.value;
    const guestId = verifyGuestToken(setCookie);
    expect(guestId).toBeTruthy();
    expect(guestId).not.toBe('guest_forged_1234567890');
    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: { type: 'VISIT', userId: null, guestId },
    });
    expect(JSON.stringify(doubles.funnelCreate.mock.calls)).not.toContain('guest_forged');
  });

  it('skips prefetch and client-side RSC navigations, so they record nothing', async () => {
    const prefetch = await proxy(
      new NextRequest('http://localhost/categories', {
        headers: { 'next-router-prefetch': '1' },
      })
    );
    const rscNavigation = await proxy(
      new NextRequest('http://localhost/register', { headers: { rsc: '1' } })
    );

    expect(prefetch.cookies.get(FUNNEL_GUEST_COOKIE)).toBeUndefined();
    expect(rscNavigation.cookies.get(FUNNEL_GUEST_COOKIE)).toBeUndefined();
    expect(doubles.funnelCreate).not.toHaveBeenCalled();
  });

  it('records VISIT with the session user ID for a signed-in entry', async () => {
    doubles.getToken.mockResolvedValue({
      id: 'user-signed-in',
      sub: 'user-signed-in',
      sessionIssuedAt: Math.floor(Date.now() / 1000),
    });

    await proxy(new NextRequest('http://localhost/categories'));

    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: { type: 'VISIT', userId: 'user-signed-in', guestId: expect.any(String) },
    });
  });

  it('keeps the response and cookie when funnel persistence fails', async () => {
    doubles.funnelCreate.mockRejectedValueOnce(new Error('db unavailable'));

    const response = await proxy(new NextRequest('http://localhost/register'));

    expect(response.cookies.get(FUNNEL_GUEST_COOKIE)?.value).toBeTruthy();
  });

  it('keeps the response and cookie when analytics storage initialization fails', async () => {
    const delegate = vi.spyOn(prisma, 'funnelEvent', 'get').mockImplementationOnce(() => {
      throw new Error('private connection details');
    });

    try {
      const response = await proxy(new NextRequest('http://localhost/register'));

      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(verifyGuestToken(response.cookies.get(FUNNEL_GUEST_COOKIE)?.value)).toBeTruthy();
      expect(doubles.funnelCreate).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith('Funnel write failed:', {
        action: 'record',
        type: 'VISIT',
        errorName: 'Error',
      });
    } finally {
      delegate.mockRestore();
    }
  });

  it('does not record VISIT for non-entry routes', async () => {
    await proxy(new NextRequest('http://localhost/api/categories'));
    await proxy(new NextRequest('http://localhost/categories/favorites'));

    expect(doubles.funnelCreate).not.toHaveBeenCalled();
  });
});

describe('direct entry reaches a successful start in the same window', () => {
  const NOW = new Date('2026-11-24T12:00:00.000Z');
  const at = (hoursBefore: number) => new Date(NOW.getTime() - hoursBefore * 60 * 60 * 1000);

  it('links a direct /register visit to the later registration and list creation', async () => {
    const response = await proxy(new NextRequest('http://localhost/register'));
    const cookieValue = response.cookies.get(FUNNEL_GUEST_COOKIE)?.value ?? '';
    const guestId = verifyGuestToken(cookieValue);

    // The later registration request carries the same browser cookie.
    const registration = new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { cookie: `${FUNNEL_GUEST_COOKIE}=${cookieValue}` },
    });
    expect(getGuestIdFromRequest(registration)).toBe(guestId);

    const events: FunnelEventRecord[] = [
      { type: 'VISIT', guestId, userId: null, createdAt: at(3) },
      { type: 'REGISTER', guestId, userId: 'user-direct', createdAt: at(2) },
      { type: 'LIST_CREATE', guestId: null, userId: 'user-direct', createdAt: at(1) },
    ];
    const summary = aggregateFunnelWindow(events, 1, NOW);
    expect(summary.stages.map((stage) => stage.count)).toEqual([1, 1, 1, 0, 0]);
  });

  it('links a direct catalog visit to a later login and list creation', async () => {
    const response = await proxy(new NextRequest('http://localhost/categories/cat-1/products'));
    const cookieValue = response.cookies.get(FUNNEL_GUEST_COOKIE)?.value ?? '';
    const guestId = verifyGuestToken(cookieValue);

    const events: FunnelEventRecord[] = [
      { type: 'VISIT', guestId, userId: null, createdAt: at(3) },
      { type: 'LOGIN', guestId, userId: 'user-catalog', createdAt: at(2) },
      { type: 'LIST_CREATE', guestId: null, userId: 'user-catalog', createdAt: at(1) },
    ];
    const summary = aggregateFunnelWindow(events, 1, NOW);
    expect(summary.stages.map((stage) => stage.count)).toEqual([1, 1, 1, 0, 0]);
  });
});

describe('homepage visit tracking', () => {
  it('no longer records VISIT in the page render, so the proxy is the single source', async () => {
    const view = await Home();

    expect(view).toBeTruthy();
    expect(doubles.funnelCreate).not.toHaveBeenCalled();
  });
});
