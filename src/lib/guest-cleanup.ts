import type { Prisma } from '@prisma/client';
import { guestMilestoneLockKey, SHARED_MILESTONE_TYPES } from '@/lib/funnel';
import { prisma } from '@/lib/prisma';

export const GUEST_CLEANUP_INACTIVE_DAYS_ENV = 'GUEST_CLEANUP_INACTIVE_DAYS';
export const DEFAULT_GUEST_INACTIVE_DAYS = 30;
export const DEFAULT_GUEST_CLEANUP_BATCH_SIZE = 500;

export type GuestCleanupDbClient = {
  /** Runs one batch (donor lock, hand-off, conditional delete) in a single transaction. */
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
  input: { donorIds: string[]; cutoff: Date },
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
 *
 * `donorIds` must be the guests the caller has locked and re-checked as stale (see
 * `lockStaleDonorIds`); only their rows move. The replacement is any active guest that is not one of
 * those donors, including a candidate that a touch made active after the scan.
 */
export async function handOffSharedMilestones(
  { donorIds, cutoff }: { donorIds: string[]; cutoff: Date },
  tx: Prisma.TransactionClient
): Promise<number> {
  if (donorIds.length === 0) return 0;

  const owned = await tx.funnelEvent.findMany({
    where: {
      userId: { in: donorIds },
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
        userId: { notIn: donorIds },
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
 * Locks the batch's candidate rows and returns the ids that are still stale under that lock. The
 * batch calls it first in its transaction, so the hand-off and the delete act only on guests that
 * cannot become active before the commit. A candidate touched after the scan drops out here.
 *
 * `FOR NO KEY UPDATE` conflicts with a touch, because a plain UPDATE of `guestLastActiveAt` takes the
 * same lock. A touch therefore either lands before this check, and that guest is no longer a donor,
 * or waits for the commit and then finds no guest. It does not conflict with the KEY SHARE lock that a
 * milestone insert takes on the user row it references, so a chain writer that already holds its
 * chain lock never waits here. Rows are locked in id order, and the check uses the batch's own
 * eligibility filter, so the rule lives in one place.
 */
export async function lockStaleDonorIds(
  candidateIds: string[],
  eligibleWhere: Prisma.UserWhereInput,
  tx: Prisma.TransactionClient
): Promise<string[]> {
  if (candidateIds.length === 0) return [];

  await tx.$queryRaw`SELECT id FROM users WHERE id = ANY(${candidateIds}::text[]) ORDER BY id FOR NO KEY UPDATE`;
  const donors = await tx.user.findMany({
    where: { id: { in: candidateIds }, ...eligibleWhere },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return donors.map((row) => row.id);
}

/**
 * Deletes server-backed guest accounts inactive longer than `inactiveDays` (and their owned
 * lists, items, history, favorites, AI usage counters and user-scoped funnel events via schema
 * cascades). Each batch locks its candidates and re-checks which are still stale under the lock
 * (see `lockStaleDonorIds`). For those donors, the shared funnel milestones move to an active guest
 * of the same chain when one exists (see `handOffSharedMilestones`), and then the donors are
 * deleted with the same conditional filter. The batch is one transaction: if a locked donor is not
 * deleted, the whole batch rolls back, so no milestone moves without its donor going.
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
    // One transaction: the donor lock, the hand-off and the conditional delete run together. The
    // donors are locked and re-checked before anything moves, so a guest touched after the scan is
    // kept with its milestones. A failure rolls everything back, and a start that joins the chain
    // waits for the commit, so its own VISIT is never ahead of a cascade that removes the chain.
    const result = await db.$transaction(async (tx) => {
      const donorIds = await lockStaleDonorIds(candidateIds, eligibleWhere, tx);
      if (donorIds.length === 0) return { count: 0 };

      await handOff({ donorIds, cutoff }, tx);
      const deleted = await tx.user.deleteMany({
        where: {
          id: { in: donorIds },
          ...eligibleWhere,
        },
      });
      // Every locked donor must go, or milestones would be moved to a guest that stays.
      if (deleted.count !== donorIds.length) {
        throw new Error(
          `Guest cleanup batch changed under its lock: ${deleted.count} of ${donorIds.length} deleted; batch rolled back`
        );
      }
      return deleted;
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
