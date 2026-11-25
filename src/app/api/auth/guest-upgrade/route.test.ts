// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRegistrationGuest, jar } = vi.hoisted(() => ({
  resolveRegistrationGuest: vi.fn(),
  jar: new Map<string, string>(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

// The intent is minted and read for real; only the request's guest session is a double.
vi.mock('@/lib/guest-promotion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/guest-promotion')>()),
  resolveRegistrationGuest,
}));

const { POST } = await import('./route');
const { readGuestUpgradeIntent } = await import('@/lib/guest-promotion');
const { GUEST_UPGRADE_INTENT_COOKIE } = await import('@/lib/guest-upgrade-intent');

const request = () => new Request('http://localhost/api/auth/guest-upgrade', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  jar.clear();
  vi.stubEnv('AUTH_SECRET', 'test-secret-for-guest-upgrade-route');
});

describe('POST /api/auth/guest-upgrade (AGE-1667)', () => {
  it('arms the upgrade for a live guest in a signed httpOnly cookie that the callback reads back', async () => {
    resolveRegistrationGuest.mockResolvedValue({
      kind: 'guest',
      userId: 'guest-row-1',
      guestId: null,
    });

    const response = await POST(request());
    const cookie = response.cookies.get(GUEST_UPGRADE_INTENT_COOKIE);

    expect(response.status).toBe(200);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.maxAge).toBe(300);

    // The value the browser would send back on the Google callback names this guest, and nothing else.
    jar.set(GUEST_UPGRADE_INTENT_COOKIE, cookie!.value);
    expect(await readGuestUpgradeIntent()).toEqual({ guestUserId: 'guest-row-1' });
  });

  it.each(['anonymous', 'promoted', 'stale'] as const)(
    'arms nothing for a %s caller: 409 and no cookie',
    async (kind) => {
      resolveRegistrationGuest.mockResolvedValue({ kind });

      const response = await POST(request());

      expect(response.status).toBe(409);
      expect(response.cookies.get(GUEST_UPGRADE_INTENT_COOKIE)).toBeUndefined();
    }
  );

  it('fails closed without an auth secret: 500 and no cookie', async () => {
    vi.stubEnv('AUTH_SECRET', '');
    vi.stubEnv('NEXTAUTH_SECRET', '');
    resolveRegistrationGuest.mockResolvedValue({
      kind: 'guest',
      userId: 'guest-row-1',
      guestId: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(response.cookies.get(GUEST_UPGRADE_INTENT_COOKIE)).toBeUndefined();
  });
});
