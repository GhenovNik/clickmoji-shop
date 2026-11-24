// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// Opt-in PostgreSQL concurrency and reconciliation integration tests for the shared monthly
// monetary AI budget. Set INTEGRATION_DATABASE_URL to a disposable migrated database to run.

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

describe.skipIf(!url)('monthly AI budget on PostgreSQL', () => {
  let db: PrismaClient;
  let reserveMonthlyAiBudget: typeof import('./ai-budget').reserveMonthlyAiBudget;
  let reconcileMonthlyAiBudget: typeof import('./ai-budget').reconcileMonthlyAiBudget;

  beforeAll(async () => {
    ({ prisma: db } = (await import('@/lib/prisma')) as unknown as { prisma: PrismaClient });
    ({ reserveMonthlyAiBudget, reconcileMonthlyAiBudget } = await import('./ai-budget'));
  });

  afterAll(async () => {
    delete process.env.AI_MONTHLY_BUDGET_USD;
    if (!db) return;
    await db.$executeRaw`DELETE FROM ai_monthly_budgets WHERE "monthStart" >= '2090-01-01T00:00:00Z'`;
    await db.$disconnect();
  });

  it('never over-reserves under concurrent PostgreSQL requests and frees unused reserve on reconciliation', async () => {
    const now = new Date('2091-05-15T12:00:00Z');
    const monthStart = new Date('2091-05-01T00:00:00Z');
    await db.$executeRaw`DELETE FROM ai_monthly_budgets WHERE "monthStart" = ${monthStart}`;

    process.env.AI_MONTHLY_BUDGET_USD = '0.120000'; // 120,000 micro-USD -> fits 3 * 40,000
    const ceiling = BigInt(40_000);

    const decisions = await Promise.all(
      Array.from({ length: 12 }, () => reserveMonthlyAiBudget({ ceilingMicroUsd: ceiling, now }))
    );

    const granted = decisions.filter((d) => d.allowed);
    const denied = decisions.filter((d) => !d.allowed);
    expect(granted).toHaveLength(3);
    expect(denied).toHaveLength(9);

    for (const item of granted) {
      if (item.allowed) {
        await reconcileMonthlyAiBudget({
          monthStart: item.monthStart,
          ceilingMicroUsd: item.ceilingMicroUsd,
          actualMicroUsd: BigInt(10_000),
        });
      }
    }

    // 3 * 10,000 = 30,000 spent -> 90,000 remaining -> fits 2 more 40,000 reservations.
    const nextWave = await Promise.all(
      Array.from({ length: 5 }, () => reserveMonthlyAiBudget({ ceilingMicroUsd: ceiling, now }))
    );
    expect(nextWave.filter((d) => d.allowed)).toHaveLength(2);
  });
});
