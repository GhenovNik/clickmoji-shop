import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const GUEST_CLEANUP_INACTIVE_DAYS_ENV = 'GUEST_CLEANUP_INACTIVE_DAYS';
export const DEFAULT_GUEST_INACTIVE_DAYS = 30;
export const DEFAULT_GUEST_CLEANUP_BATCH_SIZE = 500;

export type GuestCleanupDbClient = {
  user: {
    count: (args: { where: Prisma.UserWhereInput }) => Promise<number>;
    findMany: (args: {
      where: Prisma.UserWhereInput;
      select: { id: true };
      orderBy: Array<{ guestLastActiveAt: 'asc' } | { id: 'asc' }>;
      take: number;
    }) => Promise<Array<{ id: string }>>;
    deleteMany: (args: { where: Prisma.UserWhereInput }) => Promise<{ count: number }>;
  };
};

export type GuestCleanupResult = {
  inactiveDays: number;
  cutoff: Date;
  dryRun: boolean;
  matchedCount: number;
  deletedCount: number;
};

/**
 * Resolves and validates the inactivity threshold in days. Fails closed on zero, negative,
 * fractional or non-numeric values so a typo never wipes active or recent guest sessions.
 */
export function resolveGuestInactiveDays(raw?: string | number | null): number {
  if (raw === undefined || raw === null) {
    const envRaw = process.env[GUEST_CLEANUP_INACTIVE_DAYS_ENV];
    if (envRaw === undefined || envRaw.trim() === '') {
      return DEFAULT_GUEST_INACTIVE_DAYS;
    }
    return resolveGuestInactiveDays(envRaw);
  }

  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new Error(`Invalid guest inactive days threshold: ${raw}`);
    }
    return raw;
  }

  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Invalid guest inactive days threshold: "${trimmed}"`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid guest inactive days threshold: "${trimmed}"`);
  }

  return parsed;
}

/**
 * Builds the strict guest-only inactivity filter. Always requires `isGuest: true` and `role: 'USER'`
 * so regular accounts, admins, and recent guests are never eligible.
 */
export function inactiveGuestWhere(cutoff: Date): Prisma.UserWhereInput {
  return {
    isGuest: true,
    role: 'USER',
    OR: [
      { guestLastActiveAt: { lt: cutoff } },
      {
        guestLastActiveAt: null,
        createdAt: { lt: cutoff },
        updatedAt: { lt: cutoff },
      },
    ],
  };
}

/**
 * Deletes server-backed guest accounts inactive longer than `inactiveDays` (and their owned
 * lists, items, history, favorites, AI usage counters and user-scoped funnel events via schema
 * cascades). Re-checks eligibility inside every batch delete to avoid racing with a guest that
 * becomes active or converts concurrently.
 */
export async function cleanupInactiveGuests({
  db = prisma,
  inactiveDays = resolveGuestInactiveDays(),
  dryRun = false,
  now = new Date(),
  batchSize = DEFAULT_GUEST_CLEANUP_BATCH_SIZE,
}: {
  db?: GuestCleanupDbClient;
  inactiveDays?: number;
  dryRun?: boolean;
  now?: Date;
  batchSize?: number;
} = {}): Promise<GuestCleanupResult> {
  const days = resolveGuestInactiveDays(inactiveDays);
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`Invalid guest cleanup batch size: ${batchSize}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Invalid reference timestamp for guest cleanup');
  }

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const eligibleWhere = inactiveGuestWhere(cutoff);

  if (dryRun) {
    const matchedCount = await db.user.count({ where: eligibleWhere });
    return {
      inactiveDays: days,
      cutoff,
      dryRun: true,
      matchedCount,
      deletedCount: 0,
    };
  }

  let matchedCount = 0;
  let deletedCount = 0;

  for (;;) {
    const candidates = await db.user.findMany({
      where: eligibleWhere,
      select: { id: true },
      orderBy: [{ guestLastActiveAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });

    if (candidates.length === 0) {
      break;
    }

    matchedCount += candidates.length;
    const candidateIds = candidates.map((row) => row.id);
    const result = await db.user.deleteMany({
      where: {
        id: { in: candidateIds },
        ...eligibleWhere,
      },
    });
    deletedCount += result.count;

    if (candidates.length < batchSize) {
      break;
    }
  }

  return {
    inactiveDays: days,
    cutoff,
    dryRun: false,
    matchedCount,
    deletedCount,
  };
}
