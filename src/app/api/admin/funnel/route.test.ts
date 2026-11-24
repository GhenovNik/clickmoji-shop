// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const doubles = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findManyEvents: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: doubles.requireAdmin,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    funnelEvent: {
      findMany: doubles.findManyEvents,
    },
  },
}));

const { GET } = await import('./route');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  doubles.requireAdmin.mockReset();
  doubles.findManyEvents.mockReset().mockResolvedValue([]);
});

describe('GET /api/admin/funnel', () => {
  it('denies non-admin or unauthenticated callers before reading funnel events', async () => {
    doubles.requireAdmin.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const response = await GET(new Request('http://localhost/api/admin/funnel'));

    expect(response.status).toBe(401);
    expect(doubles.findManyEvents).not.toHaveBeenCalled();
  });

  it('returns the rolling 1/7/30-day funnel report for ADMIN users', async () => {
    doubles.requireAdmin.mockResolvedValue({
      session: { user: { id: 'admin-1', role: 'ADMIN' } },
    });
    const now = new Date();
    doubles.findManyEvents.mockResolvedValue([
      { type: 'VISIT', guestId: 'g-1', userId: null, createdAt: new Date(now.getTime() - 5000) },
      { type: 'LOGIN', guestId: 'g-1', userId: 'u-1', createdAt: new Date(now.getTime() - 4000) },
    ]);

    const response = await GET(new Request('http://localhost/api/admin/funnel'));

    expect(response.status).toBe(200);
    expect(doubles.findManyEvents).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body.windows).toHaveLength(3);
    expect(body.windows.map((w: { days: number }) => w.days)).toEqual([1, 7, 30]);
    expect(body.windows[0].stages.map((s: { count: number }) => s.count)).toEqual([1, 1, 0, 0, 0]);
  });
});
