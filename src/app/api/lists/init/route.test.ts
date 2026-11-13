// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Starter lists for an account that has none: the same set and order as email registration.

const doubles = vi.hoisted(() => ({
  findMany: vi.fn(),
  createMany: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({ requireUser: doubles.requireUser }));
vi.mock('@/lib/prisma', () => ({
  prisma: { list: { findMany: doubles.findMany, createMany: doubles.createMany } },
}));

const { POST } = await import('./route');

const EXPECTED_STARTERS = [
  { name: 'Main', isActive: true, userId: 'user-1' },
  { name: 'Weekend', isActive: false, userId: 'user-1' },
  { name: 'Holidays', isActive: false, userId: 'user-1' },
  { name: 'Party', isActive: false, userId: 'user-1' },
  { name: 'Urgent', isActive: false, userId: 'user-1' },
];

function init(locale = 'en') {
  return POST(
    new Request('http://localhost/api/lists/init', {
      method: 'POST',
      headers: { cookie: `NEXT_LOCALE=${locale}` },
    })
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  doubles.requireUser.mockResolvedValue({ session: { user: { id: 'user-1', role: 'USER' } } });
  doubles.findMany.mockReset();
  doubles.createMany.mockReset();
});

describe('POST /api/lists/init', () => {
  it('creates the shared starter set, main active, when the account has no lists', async () => {
    doubles.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: 'list-1', name: 'Main', isActive: true, userId: 'user-1', _count: { items: 0 } },
      ]);

    const response = await init();

    expect(response.status).toBe(200);
    expect(doubles.createMany).toHaveBeenCalledTimes(1);
    expect(doubles.createMany).toHaveBeenCalledWith({ data: EXPECTED_STARTERS });
  });

  it('creates nothing when the account already has lists', async () => {
    doubles.findMany.mockResolvedValue([
      { id: 'list-1', name: 'Mine', isActive: true, userId: 'user-1' },
    ]);

    const response = await init();

    expect(response.status).toBe(200);
    expect(doubles.createMany).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ message: 'Lists already exist' });
  });
});
