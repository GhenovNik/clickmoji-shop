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

  it('atomically compensates concurrent failed text operations without losing successful units', async () => {
    const { runTextAiCall } = await import('./text-ai-call');
    const { GoogleTextUnavailableError } = await import('./services/text-ai-errors');
    const outcomes = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        runTextAiCall({ id: userId, role: 'USER' }, 'en', async () => {
          if (index % 2) throw new GoogleTextUnavailableError();
          return index;
        })
      )
    );
    expect(outcomes.filter((result) => result instanceof Response)).toHaveLength(12);
    const today = new Date();
    const windowStart = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    );
    const row = await db.aiUsageCounter.findUnique({
      where: { userId_windowStart: { userId, windowStart } },
    });
    expect(row?.count).toBe(12);
  });

  it('refunds the original day across midnight without touching the new day', async () => {
    const { runTextAiCall } = await import('./text-ai-call');
    const { GoogleTextUnavailableError } = await import('./services/text-ai-errors');
    const beforeMidnight = new Date('2040-02-03T23:59:59Z');
    const afterMidnight = new Date('2040-02-04T00:00:01Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(beforeMidnight);
    try {
      const result = await runTextAiCall({ id: userId, role: 'USER' }, 'en', async () => {
        vi.setSystemTime(afterMidnight);
        await reserveAiCall({ userId, role: 'USER', now: afterMidnight });
        throw new GoogleTextUnavailableError();
      });
      expect(result).toBeInstanceOf(Response);
      const rows = await db.aiUsageCounter.findMany({
        where: { userId, windowStart: { gte: new Date('2040-02-03T00:00:00Z') } },
        orderBy: { windowStart: 'asc' },
      });
      expect(rows.map(({ count }) => count)).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('conditional compensation cannot make an empty counter negative', async () => {
    const { runTextAiCall } = await import('./text-ai-call');
    const { GoogleTextUnavailableError } = await import('./services/text-ai-errors');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2040-03-01T12:00:00Z'));
    try {
      await runTextAiCall({ id: userId, role: 'USER' }, 'en', async () => {
        await db.aiUsageCounter.updateMany({
          where: { userId, windowStart: new Date('2040-03-01T00:00:00Z') },
          data: { count: 0 },
        });
        throw new GoogleTextUnavailableError();
      });
      const row = await db.aiUsageCounter.findUnique({
        where: { userId_windowStart: { userId, windowStart: new Date('2040-03-01T00:00:00Z') } },
      });
      expect(row?.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
