import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';

export const FUNNEL_GUEST_COOKIE = 'clickmoji_funnel_guest';
export const FUNNEL_GUEST_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export const FUNNEL_EVENT_TYPES = [
  'VISIT',
  'REGISTER',
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
};

type FunnelEventDelegateLike = {
  create?: (args: {
    data: { type: FunnelEventType; userId: string | null; guestId: string | null };
  }) => Promise<unknown>;
  updateMany?: (args: {
    where: { guestId: string; userId: null };
    data: { userId: string };
  }) => Promise<unknown>;
};

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
