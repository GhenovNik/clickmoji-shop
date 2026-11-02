// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// Checks the conditional upsert of the daily AI budget on a real PostgreSQL. Opt-in like
// src/app/api/list-operations.integration.test.ts: set INTEGRATION_DATABASE_URL to a disposable,
// migrated database.

const url = process.env.INTEGRATION_DATABASE_URL;

vi.mock('@/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { createPrismaPgAdapter } = await import('@/lib/prisma-adapter');
  return {
    prisma: new PrismaClient({
      adapter: createPrismaPgAdapter(process.env.INTEGRATION_DATABASE_URL),
    }),
  };
});

describe.skipIf(!url)('reserveAiCall on PostgreSQL', () => {
  let db: PrismaClient;
  let reserveAiCall: typeof import('./ai-quota').reserveAiCall;
  let userId: string;

  beforeAll(async () => {
    ({ prisma: db } = (await import('@/lib/prisma')) as unknown as { prisma: PrismaClient });
    ({ reserveAiCall } = await import('./ai-quota'));
    const suffix = Math.random().toString(36).slice(2, 10);
    userId = (await db.user.create({ data: { email: `quota-${suffix}@example.test` } })).id;
    process.env.AI_DAILY_CALLS_PER_USER = '30';
  });

  afterAll(async () => {
    delete process.env.AI_DAILY_CALLS_PER_USER;
    if (!db) return;
    await db.user.deleteMany({ where: { id: userId } });
    expect(await db.aiUsageCounter.count({ where: { userId } })).toBe(0);
    await db.$disconnect();
  });

  it('never grants more than the limit to concurrent requests', async () => {
    const now = new Date('2026-10-30T12:00:00Z');

    const decisions = await Promise.all(
      Array.from({ length: 45 }, () => reserveAiCall({ userId, role: 'USER', now }))
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(30);
    const row = await db.aiUsageCounter.findUnique({
      where: { userId_windowStart: { userId, windowStart: new Date('2026-10-30T00:00:00Z') } },
    });
    expect(row?.count).toBe(30);
    const denied = decisions.find((decision) => !decision.allowed);
    expect(denied).toMatchObject({ resetAt: Date.parse('2026-10-31T00:00:00Z') });
  });

  it('starts a fresh budget on the next UTC day', async () => {
    const decision = await reserveAiCall({
      userId,
      role: 'USER',
      now: new Date('2026-10-31T00:00:01Z'),
    });

    expect(decision).toEqual({ allowed: true, used: 1, limit: 30 });
  });
});
