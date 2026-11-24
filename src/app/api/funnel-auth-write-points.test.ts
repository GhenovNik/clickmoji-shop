// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  findUniqueUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  createManyLists: vi.fn(),
  funnelCreate: vi.fn(),
  funnelUpdateMany: vi.fn(),
  guestCookie: undefined as string | undefined,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: doubles.findUniqueUser,
      create: doubles.createUser,
      update: doubles.updateUser,
    },
    list: {
      createMany: doubles.createManyLists,
    },
    funnelEvent: {
      create: doubles.funnelCreate,
      updateMany: doubles.funnelUpdateMany,
    },
  },
}));

vi.mock('bcryptjs', () => ({
  default: { hash: async () => 'hashed-password', compare: async () => true },
}));
vi.mock('@/lib/email', () => ({
  isEmailVerificationRequired: () => false,
  sendVerificationEmail: vi.fn(),
}));
vi.mock('@/lib/auth-tokens', () => ({
  createEmailVerificationToken: async () => 'verify-token',
}));
vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0 }) };
});
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) =>
      name === 'clickmoji_funnel_guest' && doubles.guestCookie
        ? { value: doubles.guestCookie }
        : undefined,
  }),
}));

const { POST: registerPost } = await import('@/app/api/auth/register/route');
const { authOptions } = await import('@/lib/auth');
const { FUNNEL_GUEST_COOKIE } = await import('@/lib/funnel');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  doubles.findUniqueUser.mockReset().mockResolvedValue(null);
  doubles.createUser.mockReset().mockResolvedValue({
    id: 'user-new',
    email: 'new@example.com',
    name: 'New',
  });
  doubles.updateUser.mockReset().mockResolvedValue({ id: 'user-existing' });
  doubles.createManyLists.mockReset().mockResolvedValue({ count: 5 });
  doubles.funnelCreate.mockReset().mockResolvedValue({ id: 'evt-1' });
  doubles.funnelUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  doubles.guestCookie = 'guest_auth_1234567890';
});

describe('funnel auth write points', () => {
  it('records REGISTER (with guest correlation) and starter LIST_CREATE on email registration', async () => {
    const response = await registerPost(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `NEXT_LOCALE=en; ${FUNNEL_GUEST_COOKIE}=guest_reg_1234567890`,
        },
        body: JSON.stringify({ email: 'new@example.com', password: 'password1', name: 'New' }),
      })
    );

    expect(response.status).toBe(201);
    expect(doubles.funnelCreate.mock.calls.map(([arg]) => arg.data)).toEqual([
      { type: 'REGISTER', userId: 'user-new', guestId: 'guest_reg_1234567890' },
      { type: 'LIST_CREATE', userId: 'user-new', guestId: 'guest_reg_1234567890' },
    ]);
    expect(doubles.funnelUpdateMany).toHaveBeenCalledWith({
      where: { guestId: 'guest_reg_1234567890', userId: null },
      data: { userId: 'user-new' },
    });
  });

  it('preserves registration 201 when funnel write fails', async () => {
    doubles.funnelCreate.mockRejectedValue(new Error('funnel down'));

    const response = await registerPost(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${FUNNEL_GUEST_COOKIE}=guest_reg_1234567890`,
        },
        body: JSON.stringify({ email: 'new@example.com', password: 'password1', name: 'New' }),
      })
    );

    expect(response.status).toBe(201);
  });

  it('records LOGIN on credentials signIn and correlates guest visit', async () => {
    const allowed = await authOptions.callbacks!.signIn!({
      user: { id: 'user-cred', email: 'cred@example.com' } as never,
      account: { provider: 'credentials' } as never,
    });

    expect(allowed).toBe(true);
    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: {
        type: 'LOGIN',
        userId: 'user-cred',
        guestId: 'guest_auth_1234567890',
      },
    });
    expect(doubles.funnelUpdateMany).toHaveBeenCalledWith({
      where: { guestId: 'guest_auth_1234567890', userId: null },
      data: { userId: 'user-cred' },
    });
  });

  it('records REGISTER for new Google OAuth user and LOGIN for existing Google OAuth user', async () => {
    doubles.findUniqueUser.mockResolvedValueOnce(null);
    doubles.createUser.mockResolvedValueOnce({ id: 'google-new-1' });

    const newAllowed = await authOptions.callbacks!.signIn!({
      user: { id: 'oauth-sub', email: 'NewGoogle@example.com', name: 'G' } as never,
      account: { provider: 'google' } as never,
    });

    expect(newAllowed).toBe(true);
    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: {
        type: 'REGISTER',
        userId: 'google-new-1',
        guestId: 'guest_auth_1234567890',
      },
    });

    doubles.funnelCreate.mockClear();
    doubles.findUniqueUser.mockResolvedValueOnce({
      id: 'google-existing-1',
      email: 'old@example.com',
      name: 'Old',
      image: null,
      emailVerified: new Date(),
    });

    const existingAllowed = await authOptions.callbacks!.signIn!({
      user: { id: 'oauth-sub', email: 'old@example.com' } as never,
      account: { provider: 'google' } as never,
    });

    expect(existingAllowed).toBe(true);
    expect(doubles.funnelCreate).toHaveBeenCalledWith({
      data: {
        type: 'LOGIN',
        userId: 'google-existing-1',
        guestId: 'guest_auth_1234567890',
      },
    });
  });

  it('preserves Google signIn success when funnel write fails', async () => {
    doubles.findUniqueUser.mockResolvedValueOnce({
      id: 'google-existing-1',
      email: 'old@example.com',
      name: 'Old',
      image: null,
      emailVerified: new Date(),
    });
    doubles.funnelCreate.mockRejectedValueOnce(new Error('funnel down'));

    const allowed = await authOptions.callbacks!.signIn!({
      user: { id: 'oauth-sub', email: 'old@example.com' } as never,
      account: { provider: 'google' } as never,
    });

    expect(allowed).toBe(true);
  });
});
