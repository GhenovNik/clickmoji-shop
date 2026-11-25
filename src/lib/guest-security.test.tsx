// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test/intl';

const state = vi.hoisted(() => ({
  auth: vi.fn(),
  getToken: vi.fn(),
  findUniqueUser: vi.fn(),
  updateManyUser: vi.fn(),
  createUser: vi.fn(),
  createManyLists: vi.fn(),
  createPasswordResetToken: vi.fn(),
  createEmailVerificationToken: vi.fn(),
  resendSend: vi.fn(),
  funnelCreate: vi.fn(),
  funnelUpdateMany: vi.fn(),
  useSession: vi.fn(),
  enforceAiQuotaMonthlyCount: 0,
}));

vi.mock('next-auth', () => ({
  default: () => vi.fn(),
  getServerSession: state.auth,
}));

vi.mock('next-auth/jwt', () => ({
  getToken: state.getToken,
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: state.resendSend };
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: state.findUniqueUser,
      updateMany: state.updateManyUser,
      create: state.createUser,
    },
    list: {
      createMany: state.createManyLists,
      findUnique: async () => ({ id: 'list-1', userId: 'guest-1' }),
    },
    category: {
      findMany: async () => [{ id: 'cat-1', name: 'Молочное', nameEn: 'Dairy', order: 1 }],
    },
    funnelEvent: {
      create: state.funnelCreate,
      updateMany: state.funnelUpdateMany,
    },
    $queryRaw: async () => {
      state.enforceAiQuotaMonthlyCount += 1;
      return [{ reservedMicroUsd: BigInt(100), spentMicroUsd: BigInt(0) }];
    },
  },
}));

vi.mock('@/lib/auth-tokens', () => ({
  createPasswordResetToken: state.createPasswordResetToken,
  createEmailVerificationToken: state.createEmailVerificationToken,
  consumePasswordResetToken: async () => ({ success: true }),
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return {
    ...actual,
    checkRateLimit: async () => ({ allowed: true, remaining: 10, resetAt: 0 }),
  };
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock('next-auth/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-auth/react')>();
  return {
    ...actual,
    useSession: state.useSession,
    signOut: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { authOptions } = await import('@/lib/auth');
const { requireAdmin, requireUser } = await import('@/lib/auth-guards');
const { aiDailyLimit, enforceAiQuota } = await import('@/lib/ai-quota');
const { buildGuestPlaceholderEmail } = await import('@/lib/guest');
const { default: proxy } = await import('@/proxy');
const { POST: forgotPasswordPost } = await import('@/app/api/auth/forgot-password/route');
const { POST: resendPost } = await import('@/app/api/auth/resend/route');
const { POST: registerPost } = await import('@/app/api/auth/register/route');
const { POST: importTextPost } = await import('@/app/api/lists/import-text/route');
const { POST: smartCreatePost } = await import('@/app/api/products/smart-create/route');
const { default: UserMenu } = await import('@/components/UserMenu');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.AUTH_SECRET = 'test-auth-secret-guest-security';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM_EMAIL = 'noreply@clickmoji.test';
  delete process.env.GOOGLE_GENAI_API_KEY;

  state.auth.mockReset().mockResolvedValue(null);
  state.getToken.mockReset().mockResolvedValue(null);
  state.findUniqueUser.mockReset().mockResolvedValue(null);
  state.updateManyUser.mockReset().mockResolvedValue({ count: 1 });
  state.createUser.mockReset();
  state.createManyLists.mockReset();
  state.createPasswordResetToken.mockReset();
  state.createEmailVerificationToken.mockReset();
  state.resendSend.mockReset();
  state.funnelCreate.mockReset();
  state.funnelUpdateMany.mockReset();
  state.enforceAiQuotaMonthlyCount = 0;
  state.useSession.mockReset().mockReturnValue({ data: null, status: 'unauthenticated' });
});

describe('guest session validation and deleted-user rejection', () => {
  it('accepts a brand-new guest session even when User.createdAt has sub-second milliseconds', async () => {
    const createdAt = new Date('2026-11-25T05:00:00.850Z');
    const iatSeconds = Math.floor(createdAt.getTime() / 1000); // 0.000s in same second
    const guestEmail = buildGuestPlaceholderEmail();

    state.findUniqueUser.mockResolvedValue({
      id: 'guest-live-1',
      role: 'USER',
      email: guestEmail,
      isGuest: true,
      guestLastActiveAt: createdAt,
      createdAt,
    });

    const refreshed = await authOptions.callbacks!.jwt!({
      token: {
        id: 'guest-live-1',
        role: 'USER',
        email: guestEmail,
        isGuest: true,
        iat: iatSeconds,
      } as never,
    } as never);
    expect(refreshed).toMatchObject({ id: 'guest-live-1', role: 'USER', isGuest: true });

    state.auth.mockResolvedValue({
      tokenIssuedAt: iatSeconds,
      user: { id: 'guest-live-1', role: 'USER', email: guestEmail, isGuest: true },
    });
    const guard = await requireUser();
    expect(guard).not.toBeInstanceOf(Response);
    expect(
      (guard as { session: { user: { id: string; isGuest?: boolean } } }).session.user
    ).toMatchObject({
      id: 'guest-live-1',
      isGuest: true,
    });
  });

  it('rejects a deleted guest session even if a new user is recreated with the same email', async () => {
    const guestEmail = 'guest_deleted_1@guest.clickmoji.invalid';
    const oldIssuedAt = Math.floor(Date.parse('2026-11-01T00:00:00.000Z') / 1000);

    // Lookup is strictly by id: returns null even if a new row with the same email exists.
    state.findUniqueUser.mockImplementation(
      async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id === 'guest-old-id') return null;
        if (where.email === guestEmail) {
          return {
            id: 'new-user-id',
            role: 'USER',
            email: guestEmail,
            isGuest: false,
            createdAt: new Date('2026-11-25T00:00:00.000Z'),
          };
        }
        return null;
      }
    );

    await expect(
      authOptions.callbacks!.jwt!({
        token: {
          id: 'guest-old-id',
          role: 'USER',
          email: guestEmail,
          isGuest: true,
          iat: oldIssuedAt,
        } as never,
      } as never)
    ).rejects.toThrow();

    state.auth.mockResolvedValue({
      tokenIssuedAt: oldIssuedAt,
      user: { id: 'guest-old-id', role: 'USER', email: guestEmail, isGuest: true },
    });
    const guard = await requireUser();
    expect(guard).toBeInstanceOf(Response);
    expect((guard as Response).status).toBe(401);
  });

  it('rejects a token issued before the matched User.createdAt second', async () => {
    state.findUniqueUser.mockResolvedValue({
      id: 'user-recreated',
      role: 'USER',
      email: 'u@example.com',
      isGuest: false,
      createdAt: new Date('2026-11-25T10:00:05.000Z'),
    });
    const staleIat = Math.floor(Date.parse('2026-11-25T10:00:04.000Z') / 1000);

    await expect(
      authOptions.callbacks!.jwt!({
        token: {
          id: 'user-recreated',
          role: 'USER',
          email: 'u@example.com',
          iat: staleIat,
        } as never,
      } as never)
    ).rejects.toThrow();

    state.auth.mockResolvedValue({
      tokenIssuedAt: staleIat,
      user: { id: 'user-recreated', role: 'USER', email: 'u@example.com' },
    });
    const guard = await requireUser();
    expect(guard).toBeInstanceOf(Response);
    expect((guard as Response).status).toBe(401);
  });

  it('updates guestLastActiveAt for stale guest activity without touching regular users', async () => {
    const now = Date.now();
    const iat = Math.floor((now - 10 * 60 * 1000) / 1000);
    state.auth.mockResolvedValue({
      tokenIssuedAt: iat,
      user: { id: 'guest-active', role: 'USER', isGuest: true },
    });
    state.findUniqueUser.mockResolvedValue({
      id: 'guest-active',
      role: 'USER',
      isGuest: true,
      guestLastActiveAt: new Date(now - 5 * 60 * 1000),
      createdAt: new Date(now - 10 * 60 * 1000),
    });

    await requireUser();
    expect(state.updateManyUser).toHaveBeenCalledWith({
      where: { id: 'guest-active', isGuest: true },
      data: { guestLastActiveAt: expect.any(Date) },
    });

    state.updateManyUser.mockClear();
    state.auth.mockResolvedValue({
      tokenIssuedAt: iat,
      user: { id: 'regular-user', role: 'USER', isGuest: false },
    });
    state.findUniqueUser.mockResolvedValue({
      id: 'regular-user',
      role: 'USER',
      isGuest: false,
      guestLastActiveAt: null,
      createdAt: new Date(now - 10 * 60 * 1000),
    });

    await requireUser();
    expect(state.updateManyUser).not.toHaveBeenCalled();
  });

  it('blocks guests from admin guard/routes while allowing /login and /register in proxy', async () => {
    state.auth.mockResolvedValue({
      tokenIssuedAt: Math.floor(Date.now() / 1000),
      user: { id: 'guest-1', role: 'ADMIN', isGuest: true },
    });
    const adminGuard = await requireAdmin();
    expect(adminGuard).toBeInstanceOf(Response);
    expect((adminGuard as Response).status).toBe(401);

    state.getToken.mockResolvedValue({ id: 'guest-1', role: 'USER', isGuest: true });
    const loginRes = await proxy(new NextRequest('http://localhost/login'));
    expect(loginRes.headers.get('location')).toBeNull();

    const adminRes = await proxy(new NextRequest('http://localhost/admin'));
    expect(adminRes.headers.get('location')).toBe('http://localhost/');
  });
});

describe('no outbound email for guests', () => {
  it('never sends email or creates tokens for guest accounts or placeholder addresses', async () => {
    const guestEmail = buildGuestPlaceholderEmail();
    state.findUniqueUser.mockResolvedValue({
      id: 'guest-1',
      email: guestEmail,
      isGuest: true,
      emailVerified: null,
    });

    const forgotRes = await forgotPasswordPost(
      new Request('http://localhost/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'NEXT_LOCALE=en' },
        body: JSON.stringify({ email: guestEmail }),
      })
    );
    expect(forgotRes.status).toBe(200);

    const resendRes = await resendPost(
      new Request('http://localhost/api/auth/resend', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'NEXT_LOCALE=en' },
        body: JSON.stringify({ email: guestEmail }),
      })
    );
    expect(resendRes.status).toBe(200);

    const registerRes = await registerPost(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'NEXT_LOCALE=en' },
        body: JSON.stringify({ email: guestEmail, password: 'Password1' }),
      })
    );
    expect(registerRes.status).toBe(400);

    expect(state.createPasswordResetToken).not.toHaveBeenCalled();
    expect(state.createEmailVerificationToken).not.toHaveBeenCalled();
    expect(state.resendSend).not.toHaveBeenCalled();
  });
});

describe('guest AI limits and churn prevention', () => {
  it('denies paid AI for guests through ai-quota before budget reservation or AI routes', async () => {
    expect(aiDailyLimit('USER', true)).toBe(0);

    const deniedEn = await enforceAiQuota({ id: 'guest-1', role: 'USER', isGuest: true }, 'en');
    expect(deniedEn?.status).toBe(403);
    expect(await deniedEn?.json()).toEqual({
      error: 'AI features require an account. Sign up or log in to use AI.',
    });
    expect(state.enforceAiQuotaMonthlyCount).toBe(0);

    const nowSec = Math.floor(Date.now() / 1000);
    for (const guestId of ['guest-churn-1', 'guest-churn-2']) {
      state.auth.mockResolvedValue({
        tokenIssuedAt: nowSec,
        user: { id: guestId, role: 'USER', isGuest: true },
      });
      state.findUniqueUser.mockResolvedValue({
        id: guestId,
        role: 'USER',
        isGuest: true,
        guestLastActiveAt: new Date(),
        createdProductsCount: 0,
        createdAt: new Date(nowSec * 1000),
      });

      const importRes = await importTextPost(
        new Request('http://localhost/api/lists/import-text', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: 'NEXT_LOCALE=ru' },
          body: JSON.stringify({ text: 'молоко', listId: 'list-1' }),
        })
      );
      expect(importRes.status).toBe(403);

      const smartRes = await smartCreatePost(
        new Request('http://localhost/api/products/smart-create', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: 'NEXT_LOCALE=en' },
          body: JSON.stringify({ productName: 'Dragonfruit' }),
        })
      );
      expect(smartRes.status).toBe(403);
    }

    expect(state.enforceAiQuotaMonthlyCount).toBe(0);
  });
});

describe('UserMenu guest presentation', () => {
  it('renders a localized Guest label instead of the internal placeholder email', () => {
    state.useSession.mockReturnValue({
      status: 'authenticated',
      data: {
        user: {
          id: 'guest-1',
          role: 'USER',
          isGuest: true,
          email: 'guest_secret@guest.clickmoji.invalid',
          name: null,
        },
      },
    });

    renderWithIntl(<UserMenu />, { locale: 'ru' });

    expect(screen.getByText('Гость')).toBeInTheDocument();
    expect(screen.queryByText(/guest\.clickmoji\.invalid/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/login');
  });
});
