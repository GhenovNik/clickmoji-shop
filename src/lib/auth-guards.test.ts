// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaUser = vi.hoisted(() => ({ findUnique: vi.fn() }));
const authMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: { user: prismaUser } }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/api-messages', () => ({ apiText: async (_locale: unknown, key: string) => key }));

import { requireUser } from './auth-guards';

const ACCOUNT_CREATED_AT = new Date(Date.UTC(2026, 10, 1));
const SESSION_ISSUED_AT_SEC = Math.floor(Date.UTC(2026, 10, 24, 12) / 1000);

describe('requireUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the session with the DB role for an existing account', async () => {
    authMock.mockResolvedValue({
      sessionIssuedAt: SESSION_ISSUED_AT_SEC,
      user: { id: 'user_current', email: 'ada@example.com', role: 'USER' },
    });
    prismaUser.findUnique.mockResolvedValue({
      id: 'user_current',
      role: 'ADMIN',
      createdAt: ACCOUNT_CREATED_AT,
    });

    const result = await requireUser();

    expect(result).toMatchObject({ session: { user: { id: 'user_current', role: 'ADMIN' } } });
  });

  it('does not fall back to the email when the session id no longer exists', async () => {
    // Deleted account; a re-registered account with the same email exists under a new id.
    authMock.mockResolvedValue({
      sessionIssuedAt: SESSION_ISSUED_AT_SEC,
      user: { id: 'user_old', email: 'ada@example.com', role: 'USER' },
    });
    prismaUser.findUnique.mockImplementation(
      async (args: { where: { id?: string; email?: string } }) =>
        args.where.email ? { id: 'user_new', role: 'USER' } : null
    );

    const result = await requireUser();

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    expect(prismaUser.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'ada@example.com' } })
    );
  });

  it('answers 401 without a session', async () => {
    authMock.mockResolvedValue(null);

    const result = await requireUser();

    expect((result as Response).status).toBe(401);
    expect(prismaUser.findUnique).not.toHaveBeenCalled();
  });
});
