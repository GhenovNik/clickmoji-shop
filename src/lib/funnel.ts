import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';

export const FUNNEL_GUEST_COOKIE = 'clickmoji_funnel_guest';
export const FUNNEL_GUEST_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export const FUNNEL_EVENT_TYPES = [
  'VISIT',
  'REGISTER',
  // A server guest that became an ordinary account in place (AGE-1667). Not a REGISTER: a new
  // registration and a promotion are different events, and the report counts them apart.
  'GUEST_REGISTERED',
  'LOGIN',
  'LIST_CREATE',
  'ITEM_ADD',
  'ITEM_PURCHASE',
] as const;

export type FunnelEventType = (typeof FUNNEL_EVENT_TYPES)[number];

const GUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{16,64}$/;
const GUEST_SIGNATURE_CONTEXT = 'clickmoji-funnel-guest:v1:';

export function sanitizeGuestId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return GUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function getGuestSigningSecret(): string | null {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || null;
}

/**
 * Signs a server-side guest ID as `<guestId>.<HMAC-SHA256>`. Returns null when no auth secret is
 * configured, so guest tracking fails closed instead of trusting unsigned values.
 */
export function signGuestId(guestId: string): string | null {
  const secret = getGuestSigningSecret();
  if (!secret || !GUEST_ID_PATTERN.test(guestId)) return null;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${GUEST_SIGNATURE_CONTEXT}${guestId}`)
    .digest('base64url');
  return `${guestId}.${signature}`;
}

/** Returns the guest ID only when the whole value carries a valid server signature. */
export function verifyGuestToken(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;

  const guestId = value.slice(0, separator);
  if (!GUEST_ID_PATTERN.test(guestId)) return null;

  const expected = signGuestId(guestId);
  if (!expected) return null;

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(value);
  if (expectedBuffer.length !== actualBuffer.length) return null;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer) ? guestId : null;
}

/** Mints a fresh server-side guest ID and its signed cookie value. Only the proxy calls this. */
export function mintGuestCredential(): { guestId: string; cookieValue: string } | null {
  const guestId = crypto.randomUUID();
  const cookieValue = signGuestId(guestId);
  return cookieValue ? { guestId, cookieValue } : null;
}

export function getGuestIdFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const prefix = `${FUNNEL_GUEST_COOKIE}=`;
    if (!trimmed.startsWith(prefix)) continue;
    const raw = trimmed.slice(prefix.length);
    try {
      return verifyGuestToken(decodeURIComponent(raw));
    } catch {
      return verifyGuestToken(raw);
    }
  }
  return null;
}

/**
 * Guest identity comes only from the signed cookie. Internal forwarding headers are never read,
 * so a client-supplied header cannot choose or reassign a guest ID.
 */
export function getGuestIdFromHeaders(
  headerStore: Pick<Headers, 'get'> | null | undefined
): string | null {
  if (!headerStore) return null;
  return getGuestIdFromCookieHeader(headerStore.get('cookie'));
}

export function getGuestIdFromRequest(request?: Pick<Request, 'headers'>): string | null {
  if (!request) return null;
  return getGuestIdFromHeaders(request.headers);
}

/**
 * Reads the verified guest ID from the active Next.js request cookies. Returns null outside a
 * Next.js request scope (e.g., direct unit tests).
 */
export async function readGuestIdFromRequestScope(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    return verifyGuestToken(cookieStore.get(FUNNEL_GUEST_COOKIE)?.value);
  } catch {
    return null;
  }
}

function logFunnelWriteFailure(
  action: 'record' | 'correlate',
  type: FunnelEventType,
  error: unknown
) {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const errorCode =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;

  console.error('Funnel write failed:', {
    action,
    type,
    errorName,
    ...(errorCode ? { errorCode } : {}),
  });
}

export type RecordFunnelEventInput = {
  type: FunnelEventType;
  userId?: string | null;
  guestId?: string | null;
  correlateGuest?: boolean;
  /** Skip the write when this funnel guestId already has an event of the same type. */
  dedupeByGuest?: boolean;
};

type FunnelEventDelegateLike = {
  findFirst?: (args: {
    where: { type: FunnelEventType; guestId: string };
    select: { id: true };
  }) => Promise<unknown>;
  create?: (args: {
    data: { type: FunnelEventType; userId: string | null; guestId: string | null };
  }) => Promise<unknown>;
  updateMany?: (args: {
    where: { guestId: string; userId: null };
    data: { userId: string };
  }) => Promise<unknown>;
};

const GUEST_MILESTONE_LOCK_NAMESPACE = 'clickmoji:funnel-guest-milestone:v1:';

/**
 * Lock key of one funnel guest chain. Every writer of that chain's once-per-guest milestones, every
 * guest start that joins the chain and the guest cleanup hand-off takes the same transaction-scoped
 * advisory lock, so they run in turn.
 */
export function guestMilestoneLockKey(guestId: string): string {
  return `${GUEST_MILESTONE_LOCK_NAMESPACE}${guestId}`;
}

/** Once-per-chain milestones that a guest owns and that the chain still needs after a replacement. */
export const SHARED_MILESTONE_TYPES = ['VISIT', 'REGISTER', 'LIST_CREATE'] as const;

/**
 * Timestamp for the next row of a chain: the database clock, strictly after the newest row of that
 * chain, so the chain's order is set by its writers. Call it while the chain lock is held.
 */
async function nextChainCreatedAt(tx: Prisma.TransactionClient, guestId: string): Promise<Date> {
  // A transaction-start default could place a later row before an earlier one when two writers
  // race, and equal times do not count as progression in the aggregator.
  const newest = await tx.funnelEvent.findFirst({
    where: { guestId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const floorMs = newest ? newest.createdAt.getTime() + 1 : 0;
  return new Date(Math.max(now.getTime(), floorMs));
}

/**
 * Records the VISIT of a new guest start on the funnel chain of the signed cookie. It runs inside
 * the guest creation transaction, under the chain lock, and ties the new guest User to its chain:
 * a cleanup of an older guest of that chain then hands the shared milestones to this guest.
 *
 * It is a genuine visit (a new server session entering the funnel), not a milestone. VISIT is a
 * repeatable stage: the report counts each chain once per stage and ignores a VISIT that comes
 * after the chain has progressed, so the extra row changes no count.
 */
export async function recordGuestStartVisit(
  tx: Prisma.TransactionClient,
  { userId, guestId }: { userId: string; guestId: string }
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${guestMilestoneLockKey(guestId)}, 0))`;
  await tx.funnelEvent.create({
    data: {
      type: 'VISIT',
      userId,
      guestId,
      createdAt: await nextChainCreatedAt(tx, guestId),
    },
  });
}

/**
 * Writes a once-per-guest milestone (REGISTER, LIST_CREATE). The check and the insert run in one
 * transaction that first takes a transaction-scoped PostgreSQL advisory lock keyed by the funnel
 * guestId. Concurrent starts from the same browser therefore run one after another: the second
 * one's check sees the committed row. The lock is released at commit or rollback, and no schema
 * change is needed.
 *
 * The check only counts rows owned by a guest User. An ordinary registration with the same signed
 * cookie writes its own REGISTER and LIST_CREATE under the same funnel guestId; those belong to an
 * ordinary person's chain and must not block the guest's first milestones. The owner is read from
 * the User row the event points to, so no new column is needed. Ordinary-user events keep their
 * User.id key in the report (see funnel-analytics.ts), so the two chains stay separate.
 */
async function recordGuestMilestoneOnce(
  type: FunnelEventType,
  userId: string | null,
  guestId: string
): Promise<boolean> {
  const lockKey = guestMilestoneLockKey(guestId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

    const alreadyRecorded = await tx.funnelEvent.findFirst({
      where: { type, guestId, user: { isGuest: true } },
      select: { id: true },
    });
    if (alreadyRecorded) {
      return false;
    }

    // The lock serializes the whole guest chain, so the milestone is stamped after it.
    const createdAt = await nextChainCreatedAt(tx, guestId);

    await tx.funnelEvent.create({
      data: { type, userId, guestId, createdAt },
    });
    return true;
  });
}

/**
 * Best-effort persistence for a funnel milestone. Never throws, and never logs PII or
 * private payloads if database writes fail.
 */
export async function recordFunnelEvent(input: RecordFunnelEventInput): Promise<boolean> {
  const userId = typeof input.userId === 'string' && input.userId.length > 0 ? input.userId : null;
  const guestId = sanitizeGuestId(input.guestId);

  if (!userId && !guestId) {
    return false;
  }

  let funnelEvent: FunnelEventDelegateLike | undefined;
  let recorded = false;
  try {
    funnelEvent = (prisma as unknown as { funnelEvent?: FunnelEventDelegateLike }).funnelEvent;

    if (input.dedupeByGuest && guestId) {
      // One milestone per funnel guestId: a repeated or concurrent guest start from the same browser
      // must not inflate REGISTER or LIST_CREATE. Skipped writes still correlate below.
      recorded = await recordGuestMilestoneOnce(input.type, userId, guestId);
    } else {
      if (!funnelEvent || typeof funnelEvent.create !== 'function') {
        logFunnelWriteFailure('record', input.type, new Error('Funnel event storage unavailable'));
        return false;
      }
      await funnelEvent.create({
        data: {
          type: input.type,
          userId,
          guestId,
        },
      });
      recorded = true;
    }
  } catch (error) {
    logFunnelWriteFailure('record', input.type, error);
  }

  if (input.correlateGuest && userId && guestId && funnelEvent?.updateMany) {
    try {
      await funnelEvent.updateMany({
        where: {
          guestId,
          userId: null,
        },
        data: {
          userId,
        },
      });
    } catch (error) {
      logFunnelWriteFailure('correlate', input.type, error);
    }
  }

  return recorded;
}

/**
 * Records the single promotion event of a guest that became an account in place (AGE-1667). It is
 * GUEST_REGISTERED, not REGISTER: a promotion keeps the same User.id, so it is not a new
 * registration, and the report counts it apart. It runs inside the promotion transaction, so it
 * commits with the row update or not at all. It is written even without the analytics cookie
 * (guestId null), so a promotion is never missing from the funnel. With a guestId it joins the
 * guest's chain under the chain lock, like every other milestone of that chain.
 */
export async function recordGuestPromotionEvent(
  tx: Prisma.TransactionClient,
  { userId, guestId }: { userId: string; guestId: string | null }
): Promise<void> {
  if (!guestId) {
    await tx.funnelEvent.create({
      data: { type: 'GUEST_REGISTERED', userId, guestId: null },
    });
    return;
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${guestMilestoneLockKey(guestId)}, 0))`;
  await tx.funnelEvent.create({
    data: {
      type: 'GUEST_REGISTERED',
      userId,
      guestId,
      createdAt: await nextChainCreatedAt(tx, guestId),
    },
  });
}
