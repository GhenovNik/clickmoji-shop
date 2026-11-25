// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  consumePasswordResetToken: vi.fn(),
  txUserUpdate: vi.fn(),
  txResetDeleteMany: vi.fn(),
  events: [] as string[],
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: (...args: unknown[]) => {
          doubles.events.push('lock:users');
          return doubles.queryRaw(...args);
        },
        user: { update: doubles.txUserUpdate },
        passwordResetToken: { deleteMany: doubles.txResetDeleteMany },
      }),
  },
}));

vi.mock('@/lib/auth-tokens', () => ({
  consumePasswordResetToken: async (...args: unknown[]) => {
    doubles.events.push('consume:token');
    return doubles.consumePasswordResetToken(...args);
  },
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return {
    ...actual,
    checkRateLimit: async () => ({ allowed: true, remaining: 10, resetAt: 0 }),
  };
});

import { POST } from './route';

const jsonRequest = (body: unknown) =>
  new Request('http://localhost/api/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-language': 'en' },
    body: JSON.stringify(body),
  });

const BODY = { email: 'ada@example.com', token: 'reset-token', password: 'NewPassword123' };

describe('POST /api/auth/reset-password', () => {
  beforeEach(() => {
    doubles.queryRaw.mockReset();
    doubles.consumePasswordResetToken.mockReset().mockResolvedValue({ success: true });
    doubles.txUserUpdate.mockReset().mockResolvedValue({});
    doubles.txResetDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    doubles.events.length = 0;
  });

  it('resets a registered account after locking its row before consuming the token', async () => {
    doubles.queryRaw.mockResolvedValue([
      { id: 'user_current', emailVerified: null, isGuest: false },
    ]);

    const res = await POST(jsonRequest(BODY));

    expect(res.status).toBe(200);
    expect(doubles.events).toEqual(['lock:users', 'consume:token']);
    expect(doubles.txUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_current' } })
    );
    expect(doubles.txResetDeleteMany).toHaveBeenCalled();
  });

  it('refuses a guest row and does not consume the reset token or change the password', async () => {
    doubles.queryRaw.mockResolvedValue([{ id: 'guest-1', emailVerified: null, isGuest: true }]);

    const res = await POST(jsonRequest(BODY));

    expect(res.status).toBe(400);
    expect(doubles.consumePasswordResetToken).not.toHaveBeenCalled();
    expect(doubles.txUserUpdate).not.toHaveBeenCalled();
    expect(doubles.txResetDeleteMany).not.toHaveBeenCalled();
  });

  it('refuses a placeholder guest address before any database work', async () => {
    const res = await POST(jsonRequest({ ...BODY, email: 'guest_abc@guest.clickmoji.invalid' }));

    expect(res.status).toBe(400);
    expect(doubles.queryRaw).not.toHaveBeenCalled();
    expect(doubles.consumePasswordResetToken).not.toHaveBeenCalled();
  });

  it('refuses an unknown account without consuming the token', async () => {
    doubles.queryRaw.mockResolvedValue([]);

    const res = await POST(jsonRequest(BODY));

    expect(res.status).toBe(400);
    expect(doubles.consumePasswordResetToken).not.toHaveBeenCalled();
  });
});
