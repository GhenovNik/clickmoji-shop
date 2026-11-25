// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  getServerSession: vi.fn(),
}));

vi.mock('next-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-auth')>();
  return { ...actual, getServerSession: doubles.getServerSession };
});

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const { auth } = await import('./auth');

describe('auth()', () => {
  beforeEach(() => {
    doubles.getServerSession.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('returns the session next-auth resolves for a valid token', async () => {
    const session = { user: { id: 'user-1', role: 'USER' }, expires: '2099-01-01T00:00:00Z' };
    doubles.getServerSession.mockResolvedValue(session);

    await expect(auth()).resolves.toEqual(session);
  });

  it('treats a token rejected by the jwt callback (deleted or recreated user) as signed out', async () => {
    doubles.getServerSession.mockRejectedValue(new Error('Session user no longer valid'));

    await expect(auth()).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      'Session token rejected; treating caller as signed out',
      { errorName: 'Error' }
    );
  });
});
