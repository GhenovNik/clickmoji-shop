// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decode } from 'next-auth/jwt';

const { resolveRegistrationGuest } = vi.hoisted(() => {
  process.env.AUTH_SECRET = 'test-secret-for-guest-upgrade-arm-route';
  return { resolveRegistrationGuest: vi.fn() };
});

// The liveness check is a double; the arm is minted and signed for real.
vi.mock('@/lib/guest-promotion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/guest-promotion')>()),
  resolveRegistrationGuest,
}));

const { POST } = await import('./route');
const { GUEST_UPGRADE_ARM_COOKIE, GUEST_UPGRADE_ARM_MAX_AGE_SECONDS } =
  await import('@/lib/guest-upgrade-intent');

const request = () => new Request('http://localhost/api/auth/guest-upgrade', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/guest-upgrade (AGE-1667)', () => {
  it('arms the upgrade for a live guest with a signed, short-lived, httpOnly cookie bound to that guest', async () => {
    resolveRegistrationGuest.mockResolvedValue({
      kind: 'guest',
      userId: 'guest-row-1',
      guestId: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const [line] = response.headers.getSetCookie();
    expect(line.startsWith(`${GUEST_UPGRADE_ARM_COOKIE}=`)).toBe(true);
    expect(line).toContain(`Max-Age=${GUEST_UPGRADE_ARM_MAX_AGE_SECONDS}`);
    expect(line).toContain('HttpOnly');
    const value = line.slice(GUEST_UPGRADE_ARM_COOKIE.length + 1).split(';')[0];
    const claims = await decode({
      token: value,
      secret: process.env.AUTH_SECRET as string,
      salt: GUEST_UPGRADE_ARM_COOKIE,
    });
    expect(claims).toMatchObject({ kind: 'guest-upgrade-arm', guestUserId: 'guest-row-1' });
  });

  it.each(['anonymous', 'promoted', 'stale'] as const)(
    'refuses a %s caller with 409 and no cookie',
    async (kind) => {
      resolveRegistrationGuest.mockResolvedValue({ kind });

      const response = await POST(request());

      expect(response.status).toBe(409);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  );
});
