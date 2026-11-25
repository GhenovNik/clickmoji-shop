import type { Prisma } from '@prisma/client';
import { guestMilestoneLockKey, SHARED_MILESTONE_TYPES } from '@/lib/funnel';
import { prisma } from '@/lib/prisma';

export const GUEST_CLEANUP_INACTIVE_DAYS_ENV = 'GUEST_CLEANUP_INACTIVE_DAYS';
export const DEFAULT_GUEST_INACTIVE_DAYS = 30;
export const DEFAULT_GUEST_CLEANUP_BATCH_SIZE = 500;

export type GuestCleanupDbClient = {
  /** Runs one batch hand-off and its conditional delete in a single transaction. */
  $transaction: <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cutoff that marks a guest as stale for a newer start of its funnel chain (see
 * `adoptGuestChainMilestones`). Uses the cleanup window; an invalid env value falls back to the
 * default, because failing to adopt only keeps the milestones where they are.
 */
export function staleGuestCutoff(now: Date): Date {
  let days = DEFAULT_GUEST_INACTIVE_DAYS;
  try {
    days = resolveGuestInactiveDays();
  } catch {
    days = DEFAULT_GUEST_INACTIVE_DAYS;
  }
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Lets the newest guest start of a funnel chain take over the chain's shared milestones (VISIT,
 * REGISTER, LIST_CREATE) from guests that are already stale. The earliest such row of each type
 * moves to `userId`, so the replacement keeps the full funnel even if it adds nothing before the
 * stale guest is cleaned up.
 *
 * Only stale guest owners move. A guest that is still active keeps its milestones, so a repeated or
 * simultaneous start from a live session keeps the first owner's attribution. Ordinary-user rows
 * and unowned rows never move.
 *
 * Runs inside the transaction that creates the guest User, under the chain lock. A concurrent
 * cleanup either sees the moved rows (nothing left to cascade) or commits first.
 */
export async function adoptGuestChainMilestones(
  tx: Prisma.TransactionClient,
  { userId, guestId, staleCutoff }: { userId: string; guestId: string; staleCutoff: Date }
): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${guestMilestoneLockKey(guestId)}, 0))`;

  const owned = await tx.funnelEvent.findMany({
    where: {
      guestId,
      type: { in: [...SHARED_MILESTONE_TYPES] },
      user: inactiveGuestWhere(staleCutoff),
    },
    select: { id: true, type: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const seenTypes = new Set<string>();
  const ids: string[] = [];
  for (const row of owned) {
    if (seenTypes.has(row.type)) continue;
    seenTypes.add(row.type);
    ids.push(row.id);
  }
  if (ids.length === 0) return 0;

  await tx.funnelEvent.updateMany({
    where: { id: { in: ids } },
    data: { userId },
  });
  return ids.length;
}

export type MilestoneHandOff = (
  input: { candidateIds: string[]; cutoff: Date },
  tx: Prisma.TransactionClient
) => Promise<number>;

/**
 * Keeps the shared funnel milestones (VISIT, REGISTER, LIST_CREATE) of a funnel chain alive when a
 * stale guest that owns them is deleted. The chain is keyed by the signed funnel guestId. For each
 * stale guest's chain, the earliest such milestone of every type that an active replacement guest
 * does not hold yet moves to that replacement, which is the newest active guest of the chain (a
 * stale or ordinary user never qualifies). Chains without an active replacement are left alone, so
 * the stale guest's cascade removes them as before (retention).
 *
 * A newer start adopts the chain of a stale owner as it is created (see
 * `adoptGuestChainMilestones`); this hand-off covers replacements that already hold events.
 *
 * Runs inside the caller's transaction and takes the same per-chain advisory lock as the milestone
 * writers and guest starts, in sorted order. The caller deletes the guests in that same transaction,
 * so a start cannot slip in between the move and the cascade. Only the milestone rows move: lists,
 * items, purchases and history stay with their own guest.
 */
export async function handOffSharedMilestones(
  { candidateIds, cutoff }: { candidateIds: string[]; cutoff: Date },
  tx: Prisma.TransactionClient
): Promise<number> {
  if (candidateIds.length === 0) return 0;

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
  // Sorted lock order keeps two cleanups or starts from waiting on each other's chains.
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
    // One transaction: the hand-off and the conditional delete share the chain locks. A failure
    // rolls both back (the guest stays with its milestones), and a start that adopts the chain
    // waits for the commit, so it can never see its milestones cascade away.
    const result = await db.$transaction(async (tx) => {
      await handOff({ candidateIds, cutoff }, tx);
      return tx.user.deleteMany({
        where: {
          id: { in: candidateIds },
          ...eligibleWhere,
        },
      });
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
