// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Starter lists created at registration: the same set and order as POST /api/lists/init.

const doubles = vi.hoisted(() => ({
  findUniqueUser: vi.fn(),
  createUser: vi.fn(),
  createManyLists: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: doubles.findUniqueUser, create: doubles.createUser },
    list: { createMany: doubles.createManyLists },
  },
}));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hashed-password' } }));
vi.mock('@/lib/email', () => ({
  isEmailVerificationRequired: () => false,
  sendVerificationEmail: vi.fn(),
}));
vi.mock('@/lib/auth-tokens', () => ({ createEmailVerificationToken: async () => 'verify-token' }));
vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0 }) };
});

const { POST } = await import('./route');

const EXPECTED_STARTERS = [
  { name: 'Main', isActive: true, userId: 'user-1' },
  { name: 'Weekend', isActive: false, userId: 'user-1' },
  { name: 'Holidays', isActive: false, userId: 'user-1' },
  { name: 'Party', isActive: false, userId: 'user-1' },
  { name: 'Urgent', isActive: false, userId: 'user-1' },
];

function register(locale = 'en') {
  return POST(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `NEXT_LOCALE=${locale}` },
      body: JSON.stringify({ email: 'new@example.com', password: 'password1', name: 'New' }),
    })
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  doubles.findUniqueUser.mockReset().mockResolvedValue(null);
  doubles.createUser.mockReset().mockResolvedValue({
    id: 'user-1',
    email: 'new@example.com',
    name: 'New',
  });
  doubles.createManyLists.mockReset().mockResolvedValue({ count: 5 });
});

describe('POST /api/auth/register', () => {
  it('creates the shared starter set, main active', async () => {
    const response = await register();

    expect(response.status).toBe(201);
    expect(doubles.createManyLists).toHaveBeenCalledTimes(1);
    expect(doubles.createManyLists).toHaveBeenCalledWith({ data: EXPECTED_STARTERS });
  });
});
