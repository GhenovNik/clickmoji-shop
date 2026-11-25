// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRegistrationGuest } = vi.hoisted(() => ({
  resolveRegistrationGuest: vi.fn(),
}));

// The liveness check is the only thing this route does; the guest session is a double.
vi.mock('@/lib/guest-promotion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/guest-promotion')>()),
  resolveRegistrationGuest,
}));

const { POST } = await import('./route');

const request = () => new Request('http://localhost/api/auth/guest-upgrade', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/guest-upgrade (AGE-1667)', () => {
  it('confirms a live guest and sets no cookie: the intent is bound to the OAuth state at upgrade start', async () => {
    resolveRegistrationGuest.mockResolvedValue({
      kind: 'guest',
      userId: 'guest-row-1',
      guestId: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each(['anonymous', 'promoted', 'stale'] as const)(
    'refuses a %s caller with 409 and no cookie',
    async (kind) => {
      resolveRegistrationGuest.mockResolvedValue({ kind });

      const response = await POST(request());

      expect(response.status).toBe(409);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  );
});
