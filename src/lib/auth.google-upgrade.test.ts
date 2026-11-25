// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  findUniqueUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  readIntent: vi.fn(),
  resolveGuest: vi.fn(),
  upgradeWithGoogle: vi.fn(),
  recordFunnelEvent: vi.fn(),
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

vi.mock('@/lib/guest-promotion', () => ({
  readGuestUpgradeIntent: doubles.readIntent,
  resolveGuestFromCookieStore: doubles.resolveGuest,
  upgradeGuestWithGoogle: doubles.upgradeWithGoogle,
}));

const { authOptions } = await import('./auth');

const GUEST_ID = 'guest-row-1';
const EMAIL = 'shopper@example.com';

type SignInParams = Parameters<NonNullable<typeof authOptions.callbacks>['signIn'] & object>[0];

async function googleSignIn({ verified = true }: { verified?: boolean } = {}) {
  const signIn = authOptions.callbacks!.signIn!;
  const user = { id: 'google-subject', email: EMAIL, name: 'Shopper', image: null };
  const result = await signIn({
    user,
    account: { provider: 'google', type: 'oauth', providerAccountId: 'sub' },
    profile: { email: EMAIL, email_verified: verified },
  } as unknown as SignInParams);
  return { result, user };
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.findUniqueUser.mockResolvedValue(null);
  doubles.readIntent.mockResolvedValue(false);
  doubles.resolveGuest.mockResolvedValue({ kind: 'anonymous' });
  doubles.createUser.mockResolvedValue({ id: 'new-account-1', role: 'USER' });
});

describe('Google sign-in: explicit guest upgrade (AGE-1667)', () => {
  it('promotes the live guest in place and signs that same id in', async () => {
    doubles.readIntent.mockResolvedValue(true);
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });
    doubles.upgradeWithGoogle.mockResolvedValue({
      status: 'promoted',
      user: { id: GUEST_ID, email: EMAIL, name: 'Shopper', role: 'USER' },
    });

    const { result, user } = await googleSignIn();

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
      doubles.readIntent.mockResolvedValue(true);
      doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });
      doubles.upgradeWithGoogle.mockResolvedValue({ status });

      const { result } = await googleSignIn({ verified: reason !== 'unverified' });

      expect(result).toBe(`/register?upgrade=${reason}`);
      expect(doubles.createUser).not.toHaveBeenCalled();
      expect(doubles.updateUser).not.toHaveBeenCalled();
    }
  );

  it('sends a stale guest attempt to the register page instead of creating a second user', async () => {
    doubles.readIntent.mockResolvedValue(true);
    doubles.resolveGuest.mockResolvedValue({ kind: 'stale' });
    doubles.upgradeWithGoogle.mockResolvedValue({ status: 'expired' });

    const { result } = await googleSignIn();

    expect(result).toBe('/register?upgrade=expired');
    expect(doubles.createUser).not.toHaveBeenCalled();
  });

  it('passes an existing account with the same email to the upgrade as taken, without merging', async () => {
    doubles.readIntent.mockResolvedValue(true);
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });
    doubles.findUniqueUser.mockResolvedValue({ id: 'account-9', isGuest: false, role: 'USER' });
    doubles.upgradeWithGoogle.mockResolvedValue({ status: 'email-taken' });

    const { result } = await googleSignIn();

    expect(result).toBe('/register?upgrade=email-taken');
    expect(doubles.upgradeWithGoogle).toHaveBeenCalledWith(
      expect.objectContaining({ existingUserId: 'account-9' })
    );
    expect(doubles.updateUser).not.toHaveBeenCalled();
  });

  it('falls back to ordinary sign-in when the explicit intent has no guest session behind it', async () => {
    doubles.readIntent.mockResolvedValue(true);
    doubles.resolveGuest.mockResolvedValue({ kind: 'anonymous' });

    const { result } = await googleSignIn();

    expect(result).toBe(true);
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
    expect(doubles.createUser).toHaveBeenCalledTimes(1);
  });
});

describe('Google sign-in: ordinary behaviour is unchanged (AGE-1667)', () => {
  it('never promotes a guest without the explicit intent, even with a live guest cookie', async () => {
    doubles.readIntent.mockResolvedValue(false);
    doubles.resolveGuest.mockResolvedValue({ kind: 'guest', userId: GUEST_ID, guestId: null });

    const { result } = await googleSignIn();

    expect(result).toBe(true);
    expect(doubles.upgradeWithGoogle).not.toHaveBeenCalled();
    expect(doubles.createUser).toHaveBeenCalledTimes(1);
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

    const { result, user } = await googleSignIn();

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

    const { result } = await googleSignIn();

    expect(result).toBe(false);
    expect(doubles.createUser).not.toHaveBeenCalled();
  });
});
