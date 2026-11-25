import type { Prisma } from '@prisma/client';
import { guestMilestoneLockKey } from '@/lib/funnel';
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
 * The exact complement of `inactiveGuestWhere` among guest USERs: a guest that is still within the
 * inactivity window at `cutoff`. Only such a guest may take over another guest's funnel chain.
 */
export function activeGuestWhere(cutoff: Date): Prisma.UserWhereInput {
  return {
    isGuest: true,
    role: 'USER',
    OR: [
      { guestLastActiveAt: { gte: cutoff } },
      {
        guestLastActiveAt: null,
        OR: [{ createdAt: { gte: cutoff } }, { updatedAt: { gte: cutoff } }],
      },
    ],
  };
}

/** Once-per-chain milestones that a stale guest may own and that the chain still needs. */
const SHARED_MILESTONE_TYPES = ['VISIT', 'REGISTER', 'LIST_CREATE'] as const;

export type MilestoneHandOff = (input: { candidateIds: string[]; cutoff: Date }) => Promise<number>;

/**
 * Keeps the shared funnel milestones (VISIT, REGISTER, LIST_CREATE) of a funnel chain alive when a
 * stale guest that owns them is deleted. The chain is keyed by the signed funnel guestId, which a
 * later guest start from the same browser reuses; its once-per-chain milestones stay owned by the
 * first guest. For each stale guest's chain, the earliest such milestone of every type that an
 * active replacement guest does not hold yet moves to that replacement, which is the newest active
 * guest of the chain (a stale or ordinary user never qualifies). Chains without an active
 * replacement are left alone, so the stale guest's cascade removes them as before (retention).
 *
 * Runs in one transaction that takes the same per-chain advisory lock as the milestone writers, so
 * a concurrent guest start cannot write a duplicate between the check and the move. Only the
 * milestone rows move: lists, items, purchases and history stay with their own guest.
 */
export async function handOffSharedMilestones(
  { candidateIds, cutoff }: { candidateIds: string[]; cutoff: Date },
  client: typeof prisma = prisma
): Promise<number> {
  if (candidateIds.length === 0) return 0;

  return client.$transaction(async (tx) => {
    const owned = await tx.funnelEvent.findMany({
      where: {
        userId: { in: candidateIds },
        type: { in: [...SHARED_MILESTONE_TYPES] },
        guestId: { not: null },
      },
      select: { id: true, type: true, guestId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (owned.length === 0) return 0;

    const byChain = new Map<string, typeof owned>();
    for (const row of owned) {
      if (!row.guestId) continue;
      const list = byChain.get(row.guestId);
      if (list) list.push(row);
      else byChain.set(row.guestId, [row]);
    }

    let moved = 0;
    // Sorted lock order keeps two cleanups from waiting on each other's chains.
    for (const guestId of [...byChain.keys()].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${guestMilestoneLockKey(guestId)}, 0))`;

      const replacement = await tx.funnelEvent.findFirst({
        where: {
          guestId,
          userId: { notIn: candidateIds },
          user: activeGuestWhere(cutoff),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { userId: true },
      });
      if (!replacement?.userId) continue;

      const held = await tx.funnelEvent.findMany({
        where: {
          guestId,
          userId: replacement.userId,
          type: { in: [...SHARED_MILESTONE_TYPES] },
        },
        select: { type: true },
      });
      const heldTypes = new Set(held.map((row) => row.type));

      for (const row of byChain.get(guestId) ?? []) {
        if (heldTypes.has(row.type)) continue;
        await tx.funnelEvent.update({
          where: { id: row.id },
          data: { userId: replacement.userId },
        });
        heldTypes.add(row.type);
        moved += 1;
      }
    }
    return moved;
  });
}

/**
 * Deletes server-backed guest accounts inactive longer than `inactiveDays` (and their owned
 * lists, items, history, favorites, AI usage counters and user-scoped funnel events via schema
 * cascades). Before each batch delete, the shared funnel milestones of that batch move to an
 * active guest of the same chain when one exists (see `handOffSharedMilestones`). Re-checks
 * eligibility inside every batch delete to avoid racing with a guest that becomes active or stops
 * being a guest concurrently.
 */
export async function cleanupInactiveGuests({
  db = prisma,
  inactiveDays = resolveGuestInactiveDays(),
  dryRun = false,
  now = new Date(),
  batchSize = DEFAULT_GUEST_CLEANUP_BATCH_SIZE,
  handOff = handOffSharedMilestones,
}: {
  db?: GuestCleanupDbClient;
  inactiveDays?: number;
  dryRun?: boolean;
  now?: Date;
  batchSize?: number;
  handOff?: MilestoneHandOff;
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
    // Hand-off first: a failed delete then leaves the guest in place with its milestones already
    // moved, and a repeated run finds nothing left to move.
    await handOff({ candidateIds, cutoff });
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
