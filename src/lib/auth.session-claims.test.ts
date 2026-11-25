// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decode, encode } from 'next-auth/jwt';

const doubles = vi.hoisted(() => ({
  findUniqueUser: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: doubles.findUniqueUser },
    funnelEvent: { create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/email', () => ({
  isEmailVerificationRequired: () => false,
}));

const { authOptions } = await import('./auth');

const TEST_SECRET = 'test-auth-secret-for-session-claims';
const USER_ID = 'user-stable-1';
// Fixed clock: the account row was created at CREATED_SEC; a session issued after it is fresh.
const CREATED_AT = new Date('2026-11-24T10:00:00.000Z');
const CREATED_SEC = Math.floor(CREATED_AT.getTime() / 1000);
const ISSUED_AT = CREATED_SEC + 120;
const LATER = new Date('2026-11-24T12:00:00.000Z');

type JwtParams = Parameters<NonNullable<typeof authOptions.callbacks>['jwt'] & object>[0];

async function runJwt(params: Record<string, unknown>) {
  const jwt = authOptions.callbacks!.jwt!;
  return (await jwt(params as unknown as JwtParams)) as Record<string, unknown>;
}

const dbRow = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  role: 'USER',
  email: 'shopper@example.com',
  isGuest: false,
  createdAt: CREATED_AT,
  ...overrides,
});

beforeEach(() => {
  process.env.AUTH_SECRET = TEST_SECRET;
  delete process.env.NEXTAUTH_SECRET;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(ISSUED_AT * 1000));
  doubles.findUniqueUser.mockReset().mockResolvedValue(dbRow());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session claims at initial issuance', () => {
  it('stamps an immutable sessionIssuedAt for a fresh credentials sign-in', async () => {
    const token = await runJwt({
      token: { sub: USER_ID },
      user: { id: USER_ID, role: 'USER', email: 'shopper@example.com', isGuest: false },
      account: { provider: 'credentials' },
    });

    expect(token).toMatchObject({ id: USER_ID, sub: USER_ID, sessionIssuedAt: ISSUED_AT });
    expect(doubles.findUniqueUser).not.toHaveBeenCalled();
  });

  it('identifies a Google sign-in by the User.id the signIn callback established, never by email', async () => {
    const token = await runJwt({
      token: { sub: USER_ID },
      user: { id: USER_ID, role: 'USER', email: 'shopper@example.com', isGuest: false },
      account: { provider: 'google' },
    });

    expect(token).toMatchObject({ id: USER_ID, sessionIssuedAt: ISSUED_AT });
    expect(doubles.findUniqueUser).toHaveBeenCalledTimes(1);
    expect(doubles.findUniqueUser).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { id: true, role: true, email: true, isGuest: true },
    });
    const call = JSON.stringify(doubles.findUniqueUser.mock.calls);
    expect(call).not.toContain('shopper@example.com');
  });

  it('rejects a Google sign-in whose established row is a guest account', async () => {
    doubles.findUniqueUser.mockResolvedValue(dbRow({ isGuest: true }));

    await expect(
      runJwt({
        token: { sub: USER_ID },
        user: { id: USER_ID, role: 'USER', email: 'x@example.com', isGuest: false },
        account: { provider: 'google' },
      })
    ).rejects.toThrow('Invalid OAuth user');
  });
});

describe('session refresh keeps the initial subject and issuance claim', () => {
  it('keeps id, sub and sessionIssuedAt stable while the NextAuth iat advances', async () => {
    const initial = await runJwt({
      token: { sub: USER_ID },
      user: { id: USER_ID, role: 'USER', email: 'shopper@example.com', isGuest: false },
      account: { provider: 'credentials' },
    });

    // Later refresh: NextAuth re-packs the token with a new standard iat (here: an hour later).
    vi.setSystemTime(LATER);
    const refreshed = await runJwt({
      token: { ...initial, iat: Math.floor(LATER.getTime() / 1000) },
    });

    expect(refreshed).toMatchObject({
      id: USER_ID,
      sub: USER_ID,
      sessionIssuedAt: ISSUED_AT,
    });
    // The refresh resolves the row by id only; it never looks the account up by email.
    expect(doubles.findUniqueUser).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { id: true, role: true, email: true, isGuest: true, createdAt: true },
    });
    expect(doubles.findUniqueUser.mock.calls.every(([arg]) => !('email' in arg.where))).toBe(true);
  });

  it('keeps the issuance claim across an encode/decode round trip', async () => {
    const issued = await runJwt({
      token: { sub: USER_ID },
      user: { id: USER_ID, role: 'USER', email: 'shopper@example.com', isGuest: false },
      account: { provider: 'credentials' },
    });
    const cookie = await encode({
      token: issued as never,
      secret: TEST_SECRET,
      maxAge: 60 * 60 * 24,
    });

    vi.setSystemTime(LATER);
    const decoded = await decode({ token: cookie, secret: TEST_SECRET });
    const refreshed = await runJwt({ token: decoded });

    expect(refreshed.sessionIssuedAt).toBe(ISSUED_AT);
    expect(refreshed.id).toBe(USER_ID);
  });

  it('accepts a token issued exactly at the row creation second (positive boundary)', async () => {
    const refreshed = await runJwt({
      token: { id: USER_ID, sub: USER_ID, sessionIssuedAt: CREATED_SEC },
    });
    expect(refreshed).toMatchObject({ id: USER_ID, sessionIssuedAt: CREATED_SEC });
  });
});

describe('stale and incomplete tokens are rejected on refresh', () => {
  it('rejects a token issued before the row it names was created (stale / recreated row)', async () => {
    await expect(
      runJwt({
        token: { id: USER_ID, sub: USER_ID, sessionIssuedAt: CREATED_SEC - 1 },
      })
    ).rejects.toThrow('Session user no longer valid');
  });

  it('rejects a legacy token that carries only the standard iat (no issuance claim)', async () => {
    await expect(
      runJwt({
        token: { id: USER_ID, sub: USER_ID, iat: ISSUED_AT + 3600 },
      })
    ).rejects.toThrow('Session token incomplete');
  });

  it('rejects a token that has an id but no subject', async () => {
    await expect(runJwt({ token: { id: USER_ID, sessionIssuedAt: ISSUED_AT } })).rejects.toThrow(
      'Session token incomplete'
    );
  });

  it('rejects a token whose subject disagrees with its id', async () => {
    await expect(
      runJwt({ token: { id: USER_ID, sub: 'someone-else', sessionIssuedAt: ISSUED_AT } })
    ).rejects.toThrow('Session token incomplete');
  });

  it('rejects a token with a non-numeric or non-positive issuance claim', async () => {
    for (const sessionIssuedAt of ['1700000000', 0, -5, Number.NaN]) {
      await expect(
        runJwt({ token: { id: USER_ID, sub: USER_ID, sessionIssuedAt } })
      ).rejects.toThrow('Session token incomplete');
    }
  });

  it('rejects a token whose user row no longer exists, without falling back to email', async () => {
    doubles.findUniqueUser.mockResolvedValue(null);

    await expect(
      runJwt({
        token: {
          id: USER_ID,
          sub: USER_ID,
          sessionIssuedAt: ISSUED_AT,
          email: 'shopper@example.com',
        },
      })
    ).rejects.toThrow('Session user no longer valid');
    expect(doubles.findUniqueUser.mock.calls.every(([arg]) => !('email' in arg.where))).toBe(true);
  });
});

describe('a guest token does not survive its in-place promotion (AGE-1667)', () => {
  const guestToken = () => ({
    id: USER_ID,
    sub: USER_ID,
    role: 'USER',
    email: 'guest_x@guest.clickmoji.invalid',
    isGuest: true,
    sessionIssuedAt: ISSUED_AT,
  });

  it('rejects a pre-upgrade guest token once the same row is an account', async () => {
    doubles.findUniqueUser.mockResolvedValue(dbRow({ isGuest: false }));

    await expect(runJwt({ token: guestToken() })).rejects.toThrow(
      'Guest session superseded by account'
    );
  });

  it('still refreshes a guest token while the row is a guest', async () => {
    doubles.findUniqueUser.mockResolvedValue(dbRow({ isGuest: true }));

    const token = await runJwt({ token: guestToken() });

    expect(token.isGuest).toBe(true);
  });

  it('accepts the ordinary session minted by the promotion for the same id', async () => {
    doubles.findUniqueUser.mockResolvedValue(dbRow({ isGuest: false }));

    const token = await runJwt({
      token: {
        id: USER_ID,
        sub: USER_ID,
        role: 'USER',
        isGuest: false,
        sessionIssuedAt: ISSUED_AT,
      },
    });

    expect(token).toMatchObject({ id: USER_ID, isGuest: false });
  });
});
