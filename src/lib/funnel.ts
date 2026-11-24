import crypto from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { prisma } from '@/lib/prisma';

export const FUNNEL_GUEST_COOKIE = 'clickmoji_funnel_guest';
export const FUNNEL_GUEST_HEADER = 'x-clickmoji-funnel-guest';
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

export function sanitizeGuestId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return GUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function generateGuestId(): string {
  return crypto.randomUUID();
}

export function getGuestIdFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const prefix = `${FUNNEL_GUEST_COOKIE}=`;
    if (!trimmed.startsWith(prefix)) continue;
    const raw = trimmed.slice(prefix.length);
    try {
      return sanitizeGuestId(decodeURIComponent(raw));
    } catch {
      return sanitizeGuestId(raw);
    }
  }
  return null;
}

export function getGuestIdFromHeaders(
  headerStore: Pick<Headers, 'get'> | null | undefined
): string | null {
  if (!headerStore) return null;
  const fromHeader = sanitizeGuestId(headerStore.get(FUNNEL_GUEST_HEADER));
  if (fromHeader) return fromHeader;
  return getGuestIdFromCookieHeader(headerStore.get('cookie'));
}

export function getGuestIdFromRequest(request?: Pick<Request, 'headers'>): string | null {
  if (!request) return null;
  return getGuestIdFromHeaders(request.headers);
}

/**
 * Reads the opaque guest ID from the active Next.js request scope (header set by proxy.ts
 * or cookie). Returns null outside a Next.js request scope (e.g., direct unit tests).
 */
export async function readGuestIdFromRequestScope(): Promise<string | null> {
  try {
    const headerGuestId = getGuestIdFromHeaders(await headers());
    if (headerGuestId) return headerGuestId;
  } catch {
    // Not inside a Next.js request scope.
  }

  try {
    const cookieStore = await cookies();
    return sanitizeGuestId(cookieStore.get(FUNNEL_GUEST_COOKIE)?.value);
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

  const funnelEvent = (prisma as unknown as { funnelEvent?: FunnelEventDelegateLike }).funnelEvent;
  if (!funnelEvent || typeof funnelEvent.create !== 'function') {
    return false;
  }

  let recorded = false;
  try {
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

  if (input.correlateGuest && userId && guestId && typeof funnelEvent.updateMany === 'function') {
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
