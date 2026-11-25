// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaUser = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('./prisma', () => ({ prisma: { user: prismaUser } }));
vi.mock('./email', () => ({ isEmailVerificationRequired: () => false }));
vi.mock('./funnel', () => ({
  readGuestIdFromRequestScope: async () => null,
  recordFunnelEvent: async () => undefined,
}));

import { authOptions } from './auth';

type Callbacks = NonNullable<typeof authOptions.callbacks>;
const callbacks = authOptions.callbacks as Required<Callbacks>;

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const NOW_SEC = Math.floor(NOW / 1000);
const ISSUED_SEC = NOW_SEC - 60;
const DB_CREATED_AT = new Date(Date.UTC(2026, 10, 1));

const dbUser = (
  overrides: Partial<{
    id: string;
    email: string;
    role: string;
    isGuest: boolean;
    createdAt: Date;
  }> = {}
) => ({
  id: 'user_current',
  email: 'ada@example.com',
  role: 'USER',
  isGuest: false,
  createdAt: DB_CREATED_AT,
  ...overrides,
});

// Mirrors the NextAuth JWT shape after sign-in: the callback receives the token it will encode.
const sessionToken = (overrides: Record<string, unknown> = {}) => ({
  name: null,
  email: 'ada@example.com',
  picture: null,
  sub: 'user_current',
  id: 'user_current',
  role: 'USER',
  sessionIssuedAt: ISSUED_SEC,
  ...overrides,
});

describe('auth jwt callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('binds a credentials sign-in to the authorized DB id and stamps issuance in seconds', async () => {
    const token = await callbacks.jwt({
      token: { name: null, email: null, picture: null, sub: 'x' },
      user: {
        id: 'user_current',
        email: 'ada@example.com',
        role: 'ADMIN',
        isGuest: false,
      } as never,
    } as never);

    expect(token).toMatchObject({
      id: 'user_current',
      sub: 'user_current',
      role: 'ADMIN',
      isGuest: false,
      sessionIssuedAt: NOW_SEC,
    });
  });

  it('gives a Google sign-in the DB id that signIn resolved, not the Google subject', async () => {
    prismaUser.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(dbUser({ id: 'user_google' }));
    prismaUser.create.mockResolvedValue(dbUser({ id: 'user_google' }));

    const user = { id: 'google-sub-123', email: 'ada@example.com', name: 'Ada', image: null };
    await expect(
      callbacks.signIn({
        user,
        account: { provider: 'google' } as never,
        profile: {} as never,
      } as never)
    ).resolves.toBe(true);

    const token = await callbacks.jwt({
      token: { sub: 'google-sub-123' } as never,
      user,
    } as never);

    expect(user.id).toBe('user_google');
    expect(token).toMatchObject({
      id: 'user_google',
      sub: 'user_google',
      sessionIssuedAt: NOW_SEC,
    });
  });

  it('refreshes role from the DB by id and never moves the original issuance time', async () => {
    prismaUser.findUnique.mockResolvedValue(dbUser({ role: 'ADMIN' }));

    const token = await callbacks.jwt({ token: sessionToken(), trigger: 'update' } as never);

    expect(token).toMatchObject({
      id: 'user_current',
      role: 'ADMIN',
      isGuest: false,
      sessionIssuedAt: ISSUED_SEC,
    });
    expect(prismaUser.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_current' } })
    );
    expect(prismaUser.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: expect.anything() } })
    );
  });

  it('takes the guest mark from the DB row, not from the token', async () => {
    prismaUser.findUnique.mockResolvedValue(dbUser({ isGuest: true }));

    const token = await callbacks.jwt({
      token: sessionToken({ isGuest: false }),
      trigger: 'update',
    } as never);

    expect(token).toMatchObject({ isGuest: true });
  });

  it('rejects a deleted account: the old token does not rebind to a re-registered email', async () => {
    // Account deleted, then the same email registered again under a new id.
    prismaUser.findUnique.mockImplementation(
      async (args: { where: { id?: string; email?: string } }) =>
        args.where.email === 'ada@example.com' ? dbUser({ id: 'user_new' }) : null
    );

    await expect(
      callbacks.jwt({ token: sessionToken(), trigger: 'update' } as never)
    ).rejects.toThrow('Session user no longer valid');
    expect(prismaUser.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'ada@example.com' } })
    );
  });

  it('rejects a token issued before the account existed', async () => {
    prismaUser.findUnique.mockResolvedValue(dbUser({ createdAt: new Date(NOW - 1000) }));

    await expect(
      callbacks.jwt({
        token: sessionToken({ sessionIssuedAt: ISSUED_SEC }),
        trigger: 'update',
      } as never)
    ).rejects.toThrow('Session user no longer valid');
  });

  it('rejects a legacy token without the issuance claim without touching the DB', async () => {
    const legacy = sessionToken({ sessionIssuedAt: undefined, iat: NOW_SEC });

    await expect(callbacks.jwt({ token: legacy, trigger: 'update' } as never)).rejects.toThrow(
      'Session token incomplete'
    );
    expect(prismaUser.findUnique).not.toHaveBeenCalled();
  });
});

describe('auth session callback', () => {
  it('exposes the token id, role and guest mark to the client session', async () => {
    const session = await callbacks.session({
      session: { user: { email: 'ada@example.com' }, expires: 'x' },
      token: sessionToken({ role: 'ADMIN', isGuest: true }),
    } as never);

    expect(session.user).toMatchObject({ id: 'user_current', role: 'ADMIN', isGuest: true });
  });
});
