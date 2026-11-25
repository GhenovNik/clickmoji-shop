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

export type MilestoneHandOff = (
  input: { candidateIds: string[]; cutoff: Date },
  tx: Prisma.TransactionClient
) => Promise<number>;

/**
 * Keeps the shared funnel milestones (VISIT, REGISTER, LIST_CREATE) of a funnel chain alive when a
 * stale guest that owns them is deleted. The chain is keyed by the signed funnel guestId. Every new
 * guest start writes a VISIT on its chain (see `recordGuestStartVisit`), so a guest started with it
 * holds a row there. The newest active guest of the chain is the replacement: a stale or ordinary user
 * never qualifies, and a chain without an active replacement is left alone, so the stale guest's
 * cascade removes it as before (retention).
 *
 * For each stale guest's chain, the earliest row of each type moves to the replacement unless the
 * replacement already holds that type from an earlier moment. Moving the earliest row keeps the
 * chain's stage order: a later replacement VISIT never ends up before REGISTER or LIST_CREATE.
 * Later rows of the stale guest are not moved and cascade with it.
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
    select: { id: true, type: true, guestId: true, createdAt: true },
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
      select: { type: true, createdAt: true },
    });
    const heldSince = new Map<string, number>();
    for (const row of held) {
      const at = heldSince.get(row.type);
      const ms = row.createdAt.getTime();
      if (at === undefined || ms < at) heldSince.set(row.type, ms);
    }

    // Rows arrive in chain order, so the first one of each type is the candidate's earliest.
    const decided = new Set<string>();
    for (const row of byChain.get(guestId) ?? []) {
      if (decided.has(row.type)) continue;
      decided.add(row.type);
      const since = heldSince.get(row.type);
      if (since !== undefined && since <= row.createdAt.getTime()) continue;
      await tx.funnelEvent.update({
        where: { id: row.id },
        data: { userId: replacement.userId },
      });
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
    // rolls both back (the guest stays with its milestones), and a start that joins the chain waits
    // for the commit, so its own VISIT is never ahead of a cascade that removes the chain.
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
