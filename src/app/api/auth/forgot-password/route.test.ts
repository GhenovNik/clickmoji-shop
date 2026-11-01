// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The answer and the reset email follow the language of the request (NEXT_LOCALE cookie, then
// Accept-Language).

const doubles = vi.hoisted(() => ({
  findUser: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: doubles.findUser } } }));
vi.mock('@/lib/auth-tokens', () => ({ createPasswordResetToken: async () => 'reset-token' }));
vi.mock('@/lib/email', () => ({ sendPasswordResetEmail: doubles.sendPasswordResetEmail }));
vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0 }) };
});

const { POST } = await import('./route');

function forgot(email: string, headers: Record<string, string>) {
  return POST(
    new Request('http://localhost/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email }),
    })
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  doubles.findUser.mockReset();
  doubles.sendPasswordResetEmail.mockReset();
});

describe('POST /api/auth/forgot-password', () => {
  it('answers a missing email in English', async () => {
    const response = await forgot('', { cookie: 'NEXT_LOCALE=en' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Email is required' });
  });

  it('answers a missing email in Russian for a Russian browser', async () => {
    const response = await forgot('', { 'accept-language': 'ru-RU,ru;q=0.9' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Email обязателен' });
  });

  it('sends the reset email in the language of the request', async () => {
    doubles.findUser.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });

    const response = await forgot('User@Example.com', { cookie: 'NEXT_LOCALE=en' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'If the address exists, the email has been sent',
    });
    expect(doubles.sendPasswordResetEmail).toHaveBeenCalledWith({
      email: 'user@example.com',
      token: 'reset-token',
      locale: 'en',
    });
  });

  it('reports a failed send in English', async () => {
    doubles.findUser.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
    doubles.sendPasswordResetEmail.mockRejectedValue(new Error('smtp down'));

    const response = await forgot('user@example.com', { cookie: 'NEXT_LOCALE=en' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Could not send the email' });
  });
});
