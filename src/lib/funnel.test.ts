// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
    funnelEvent: {
      create: doubles.funnelCreate,
      updateMany: doubles.funnelUpdateMany,
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
  FUNNEL_GUEST_HEADER,
  getGuestIdFromCookieHeader,
  getGuestIdFromRequest,
  recordFunnelEvent,
  sanitizeGuestId,
} = await import('./funnel');
const { default: proxy } = await import('@/proxy');
const { default: Home } = await import('@/app/page');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  doubles.funnelCreate.mockReset().mockResolvedValue({ id: 'evt-1' });
  doubles.funnelUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  doubles.headerMap.clear();
  doubles.cookieMap.clear();
  doubles.auth.mockReset().mockResolvedValue(null);
  doubles.getToken.mockReset().mockResolvedValue(null);
});

describe('funnel guest helpers', () => {
  it('accepts valid opaque guest IDs and rejects invalid or oversized values', () => {
    expect(sanitizeGuestId('guest_1234567890abcdef')).toBe('guest_1234567890abcdef');
    expect(sanitizeGuestId('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000'
    );
    expect(sanitizeGuestId('too-short')).toBeNull();
    expect(sanitizeGuestId('invalid$chars!1234567890')).toBeNull();
    expect(sanitizeGuestId('a'.repeat(65))).toBeNull();
    expect(sanitizeGuestId(null)).toBeNull();
  });

  it('extracts guest ID from header or cookie on a Request', () => {
    const reqFromHeader = new Request('http://localhost/api/lists', {
      headers: { [FUNNEL_GUEST_HEADER]: 'guest_1234567890abcdef' },
    });
    expect(getGuestIdFromRequest(reqFromHeader)).toBe('guest_1234567890abcdef');

    const reqFromCookie = new Request('http://localhost/api/lists', {
      headers: { cookie: `other=1; ${FUNNEL_GUEST_COOKIE}=guest_abcdef1234567890` },
    });
    expect(getGuestIdFromRequest(reqFromCookie)).toBe('guest_abcdef1234567890');
    expect(getGuestIdFromCookieHeader(`${FUNNEL_GUEST_COOKIE}=bad`)).toBeNull();
  });
});

describe('recordFunnelEvent', () => {
  it('stores only event type and opaque IDs, and correlates anonymous guest rows on auth', async () => {
    const ok = await recordFunnelEvent({
      type: 'REGISTER',
      userId: 'user-123',
      guestId: 'guest_1234567890abcdef',
      correlateGuest: true,
    });

    expect(ok).toBe(true);
    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: {
        type: 'REGISTER',
        userId: 'user-123',
        guestId: 'guest_1234567890abcdef',
      },
    });
    expect(doubles.funnelUpdateMany).toHaveBeenCalledWith({
      where: {
        guestId: 'guest_1234567890abcdef',
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

describe('public landing visit tracking (proxy + Home)', () => {
  it('mints and forwards an opaque guest cookie on non-prefetch GET /', async () => {
    const request = new NextRequest('http://localhost/');
    const response = await proxy(request);

    const setCookie = response.cookies.get(FUNNEL_GUEST_COOKIE)?.value;
    expect(sanitizeGuestId(setCookie)).toBeTruthy();
    expect(response.headers.get(`x-middleware-request-${FUNNEL_GUEST_HEADER}`)).toBe(setCookie);
  });

  it('preserves an existing valid guest cookie without rotating it and skips prefetch requests', async () => {
    const existing = 'guest_existing_1234567890';
    const normalReq = new NextRequest('http://localhost/', {
      headers: { cookie: `${FUNNEL_GUEST_COOKIE}=${existing}` },
    });
    const normalRes = await proxy(normalReq);
    expect(normalRes.cookies.get(FUNNEL_GUEST_COOKIE)).toBeUndefined();
    expect(normalRes.headers.get(`x-middleware-request-${FUNNEL_GUEST_HEADER}`)).toBe(existing);

    const prefetchReq = new NextRequest('http://localhost/', {
      headers: { 'next-router-prefetch': '1' },
    });
    const prefetchRes = await proxy(prefetchReq);
    expect(prefetchRes.cookies.get(FUNNEL_GUEST_COOKIE)).toBeUndefined();
    expect(prefetchRes.headers.get(`x-middleware-request-${FUNNEL_GUEST_HEADER}`)).toBeNull();
  });

  it('records VISIT on Home render and stays resilient when funnel persistence fails', async () => {
    doubles.headerMap.set(FUNNEL_GUEST_HEADER, 'guest_landing_1234567890');
    doubles.funnelCreate.mockRejectedValueOnce(new Error('db unavailable'));

    const view = await Home();

    expect(view).toBeTruthy();
    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: {
        type: 'VISIT',
        guestId: 'guest_landing_1234567890',
        userId: null,
      },
    });
  });

  it('skips VISIT on Home render for prefetch requests', async () => {
    doubles.headerMap.set(FUNNEL_GUEST_HEADER, 'guest_landing_1234567890');
    doubles.headerMap.set('purpose', 'prefetch');

    await Home();

    expect(doubles.funnelCreate).not.toHaveBeenCalled();
  });
});
