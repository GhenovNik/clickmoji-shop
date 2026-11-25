// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  findUniqueUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  resolveGuest: vi.fn(),
  upgradeWithGoogle: vi.fn(),
  recordFunnelEvent: vi.fn(),
  jar: new Map<string, string>(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = doubles.jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: doubles.findUniqueUser,
      create: doubles.createUser,
      update: doubles.updateUser,
    },
  },
}));

vi.mock('@/lib/email', () => ({
  isEmailVerificationRequired: () => false,
}));

vi.mock('@/lib/funnel', () => ({
  readGuestIdFromRequestScope: async () => null,
  recordFunnelEvent: doubles.recordFunnelEvent,
}));

// The intent is read and signed for real; only the guest session lookup and promotion are doubles.
vi.mock('@/lib/guest-promotion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/guest-promotion')>()),
  resolveGuestFromCookieStore: doubles.resolveGuest,
  upgradeGuestWithGoogle: doubles.upgradeWithGoogle,
}));

const { authOptions } = await import('./auth');
const { mintGuestUpgradeIntent } = await import('./guest-promotion');
const { GUEST_UPGRADE_INTENT_COOKIE } = await import('./guest-upgrade-intent');

const SECRET = 'test-secret-for-google-upgrade-callback';
const GUEST_ID = 'guest-row-1';
const EMAIL = 'shopper@example.com';
const NOW = Math.floor(Date.now() / 1000);

type SignInParams = Parameters<NonNullable<typeof authOptions.callbacks>['signIn'] & object>[0];

/** Arms the explicit upgrade the way POST /api/auth/guest-upgrade does: a signed httpOnly cookie. */
async function armUpgrade(guestUserId = GUEST_ID, issuedAt = NOW) {
  doubles.jar.set(GUEST_UPGRADE_INTENT_COOKIE, await mintGuestUpgradeIntent(guestUserId, issuedAt));
}

async function callback(
  provider: 'google' | 'google-upgrade',
  { verified = true }: { verified?: boolean } = {}
) {
  const signIn = authOptions.callbacks!.signIn!;
  const user = { id: 'google-subject', email: EMAIL, name: 'Shopper', image: null };
  const result = await signIn({
    user,
    account: { provider, type: 'oauth', providerAccountId: 'sub' },
    profile: { email: EMAIL, email_verified: verified },
  } as unknown as SignInParams);
  return { result, user };
}

const upgrade = (opts?: { verified?: boolean }) => callback('google-upgrade', opts);

beforeEach(() => {
  vi.clearAllMocks();
  doubles.jar.clear();
  vi.stubEnv('AUTH_SECRET', SECRET);
  doubles.findUniqueUser.mockResolvedValue(null);
  doubles.resolveGuest.mockResolvedValue({ kind: 'anonymous' });
  doubles.createUser.mockResolvedValue({ id: 'new-account-1', role: 'USER' });
});

describe('Google upgrade callback: explicit guest upgrade (AGE-1667)', () => {
  it('promotes the live guest in place and signs that same id in', async () => {
    await armUpgrade();
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });
    doubles.upgradeWithGoogle.mockResolvedValue({
      status: 'promoted',
      user: { id: GUEST_ID, email: EMAIL, name: 'Shopper', role: 'USER' },
    });

    const { result, user } = await upgrade();

    expect(result).toBe(true);
    expect(user.id).toBe(GUEST_ID);
    expect(doubles.upgradeWithGoogle).toHaveBeenCalledWith(
      expect.objectContaining({ email: EMAIL, emailVerified: true, existingUserId: null })
    );
    expect(doubles.createUser).not.toHaveBeenCalled();
  });

  it.each([
    ['email-taken', 'email-taken'],
    ['unverified', 'unverified'],
    ['expired', 'expired'],
  ])(
    'redirects a refused upgrade (%s) to the register page with no session and no new user',
    async (status, reason) => {
      await armUpgrade();
      doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });
      doubles.upgradeWithGoogle.mockResolvedValue({ status });

      const { result } = await upgrade({ verified: reason !== 'unverified' });

      expect(result).toBe(`/register?upgrade=${reason}`);
      expect(doubles.createUser).not.toHaveBeenCalled();
      expect(doubles.updateUser).not.toHaveBeenCalled();
    }
  );

  it('passes an existing account with the same email to the upgrade as taken, without merging', async () => {
    await armUpgrade();
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });
    doubles.findUniqueUser.mockResolvedValue({ id: 'account-9', isGuest: false, role: 'USER' });
    doubles.upgradeWithGoogle.mockResolvedValue({ status: 'email-taken' });

    const { result } = await upgrade();

    expect(result).toBe('/register?upgrade=email-taken');
    expect(doubles.upgradeWithGoogle).toHaveBeenCalledWith(
      expect.objectContaining({ existingUserId: 'account-9' })
    );
    expect(doubles.updateUser).not.toHaveBeenCalled();
  });

  it('never falls back to ordinary sign-up when the upgrade callback has no intent', async () => {
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });

    const { result } = await upgrade();

    expect(result).toBe('/register?upgrade=expired');
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
    expect(doubles.createUser).not.toHaveBeenCalled();
  });

  it('never falls back to ordinary sign-up when the upgrade has no guest session behind it', async () => {
    await armUpgrade();
    doubles.resolveGuest.mockResolvedValue({ kind: 'anonymous' });

    const { result } = await upgrade();

    expect(result).toBe('/register?upgrade=expired');
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
    expect(doubles.createUser).not.toHaveBeenCalled();
  });

  it('refuses an intent armed for a different guest than the live session', async () => {
    await armUpgrade('guest-row-other');
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });

    const { result } = await upgrade();

    expect(result).toBe('/register?upgrade=expired');
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
    expect(doubles.createUser).not.toHaveBeenCalled();
  });

  it('refuses a forged intent cookie signed with another secret', async () => {
    doubles.jar.set(
      GUEST_UPGRADE_INTENT_COOKIE,
      await (async () => {
        vi.stubEnv('AUTH_SECRET', 'attacker-secret');
        const forged = await mintGuestUpgradeIntent(GUEST_ID);
        vi.stubEnv('AUTH_SECRET', SECRET);
        return forged;
      })()
    );
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });

    const { result } = await upgrade();

    expect(result).toBe('/register?upgrade=expired');
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
  });

  it('refuses a plain browser-set value, as the old client flag was', async () => {
    doubles.jar.set(GUEST_UPGRADE_INTENT_COOKIE, 'google');
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });

    const { result } = await upgrade();

    expect(result).toBe('/register?upgrade=expired');
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
  });

  it('refuses an intent older than its five-minute life even if the cookie still exists', async () => {
    await armUpgrade(GUEST_ID, NOW - 5 * 60);
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });

    const { result } = await upgrade();

    expect(result).toBe('/register?upgrade=expired');
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
  });

  it('sends a stale guest to the register page instead of creating a second user', async () => {
    await armUpgrade();
    doubles.resolveGuest.mockResolvedValue({ kind: 'stale' });

    const { result } = await upgrade();

    expect(result).toBe('/register?upgrade=expired');
    expect(doubles.createUser).not.toHaveBeenCalled();
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
  });

  it('refuses a replay: the same intent once the guest is already an account', async () => {
    await armUpgrade();
    doubles.resolveGuest.mockResolvedValueOnce({ kind: 'guest', userId: GUEST_ID, guestId: null });
    doubles.upgradeWithGoogle.mockResolvedValueOnce({
      status: 'promoted',
      user: { id: GUEST_ID, email: EMAIL, name: 'Shopper', role: 'USER' },
    });
    expect((await upgrade()).result).toBe(true);

    doubles.resolveGuest.mockResolvedValue({ kind: 'promoted' });
    const replay = await upgrade();

    expect(replay.result).toBe('/register?upgrade=expired');
    expect(doubles.upgradeWithGoogle).toHaveBeenCalledTimes(1);
    expect(doubles.createUser).not.toHaveBeenCalled();
  });

  it('refuses an upgrade whose provider returned no email', async () => {
    await armUpgrade();
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });
    const signIn = authOptions.callbacks!.signIn!;
    const result = await signIn({
      user: { id: 'google-subject', email: null, name: null, image: null },
      account: { provider: 'google-upgrade', type: 'oauth', providerAccountId: 'sub' },
      profile: {},
    } as unknown as SignInParams);

    expect(result).toBe('/register?upgrade=unverified');
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
  });
});

describe('Google sign-in: ordinary behaviour never reads the upgrade (AGE-1667)', () => {
  it('never promotes a guest, even with a live guest session and a valid intent cookie', async () => {
    await armUpgrade();
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });

    const { result } = await callback('google');

    expect(result).toBe(true);
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
    expect(doubles.resolveGuest).not.toHaveBeenCalled();
    expect(doubles.createUser).toHaveBeenCalledTimes(1);
  });

  it('keeps a leftover upgrade intent from changing a canceled-then-ordinary sign-in', async () => {
    await armUpgrade();
    doubles.findUniqueUser.mockResolvedValue({
      id: 'account-9',
      email: EMAIL,
      name: null,
      image: null,
      role: 'USER',
      isGuest: false,
      emailVerified: new Date(),
    });

    const { result, user } = await callback('google');

    expect(result).toBe(true);
    expect(user.id).toBe('account-9');
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
    expect(doubles.createUser).not.toHaveBeenCalled();
  });

  it('signs into an existing account with the same email as before', async () => {
    doubles.findUniqueUser.mockResolvedValue({
      id: 'account-9',
      email: EMAIL,
      name: null,
      image: null,
      role: 'USER',
      isGuest: false,
      emailVerified: new Date(),
    });

    const { result, user } = await callback('google');

    expect(result).toBe(true);
    expect(user.id).toBe('account-9');
    expect(doubles.createUser).not.toHaveBeenCalled();
  });

  it('still refuses a Google sign-in that targets a guest row', async () => {
    doubles.findUniqueUser.mockResolvedValue({
      id: GUEST_ID,
      email: 'guest-1@guest.invalid',
      isGuest: true,
    });

    const { result } = await callback('google');

    expect(result).toBe(false);
    expect(doubles.createUser).not.toHaveBeenCalled();
  });
});
