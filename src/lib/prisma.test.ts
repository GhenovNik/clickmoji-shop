import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  vi.resetModules();
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  if (originalDatabaseUrl) {
    process.env.DATABASE_URL = originalDatabaseUrl;
    return;
  }

  delete process.env.DATABASE_URL;
});

describe('prisma module lazy initialization', () => {
  it('imports without DATABASE_URL', async () => {
    await expect(import('./prisma')).resolves.toBeDefined();
  });

  it('throws when prisma is accessed without DATABASE_URL', async () => {
    const { prisma } = await import('./prisma');

    expect(() => prisma.user).toThrow('DATABASE_URL is not set');
  });
});
