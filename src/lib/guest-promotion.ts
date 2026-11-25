import { decode, encode } from 'next-auth/jwt';
import { prisma } from '@/lib/prisma';
import {
  currentSessionIssuedAtSeconds,
  GUEST_SESSION_MAX_AGE_SECONDS,
  isSessionTokenFreshForUser,
  NEXTAUTH_SECURE_SESSION_COOKIE,
  NEXTAUTH_SESSION_COOKIE,
  shouldUseSecureSessionCookies,
} from '@/lib/guest';
import { getGuestIdFromRequest, recordGuestPromotionEvent } from '@/lib/funnel';
import { recordGuestActivity } from '@/lib/guest-activity';

/**
 * In-place promotion of a server-backed guest into an ordinary account (AGE-1667).
 *
 * The guest's User row keeps its id, so lists, items, purchases, history and favorites keep their
 * owner. Only the identity columns change (email, password, name, emailVerified) and isGuest flips
 * to false, in one conditional update `where { id, isGuest: true }`. No second row is created, no
 * accounts are merged and no starter lists are re-created. See docs/guest-shopping.md (Decisions).
 */

type SessionClaims = {
  id?: unknown;
  isGuest?: unknown;
  sessionIssuedAt?: unknown;
};

function getAuthSecret(): string | null {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || null;
}

/**
 * Reads the NextAuth session cookie and verifies its signature. Returns null when there is no
 * cookie, no secret or an invalid token. It does not consult the database: callers do that.
 */
export async function readSessionClaimsFromRequest(
  request: Pick<Request, 'headers'>
): Promise<SessionClaims | null> {
  const secret = getAuthSecret();
  const cookieHeader = request.headers.get('cookie');
  if (!secret || !cookieHeader) return null;

  const names = new Set([NEXTAUTH_SESSION_COOKIE, NEXTAUTH_SECURE_SESSION_COOKIE]);
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!names.has(name)) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) continue;
    try {
      const claims = await decode({ token: value, secret });
      if (claims) return claims as SessionClaims;
    } catch {
      // A malformed or foreign cookie is not a guest session; try the other cookie name.
    }
  }
  return null;
}

/**
 * What a registration request may do with the guest session it carries:
 * - `guest`: a live guest row with a fresh token. Registration promotes that row.
 * - `promoted`: a guest token whose row is already an account (a retry, a second tab or a stale
 *   cookie). Registration is refused, so no second account is created for the same browser.
 * - `anonymous`: no guest session, or the guest row was removed by cleanup. Registration creates an
 *   ordinary account, exactly as for any visitor.
 */
export type RegistrationGuestState =
  | { kind: 'anonymous' }
  | { kind: 'promoted' }
  | { kind: 'guest'; userId: string; guestId: string | null };

export async function resolveRegistrationGuest(
  request: Pick<Request, 'headers'>
): Promise<RegistrationGuestState> {
  const claims = await readSessionClaimsFromRequest(request);
  if (!claims || claims.isGuest !== true || typeof claims.id !== 'string' || !claims.id) {
    return { kind: 'anonymous' };
  }

  const row = await prisma.user.findUnique({
    where: { id: claims.id },
    select: { id: true, isGuest: true, createdAt: true },
  });
  if (!row) return { kind: 'anonymous' };
  if (!row.isGuest) return { kind: 'promoted' };
  if (!isSessionTokenFreshForUser(claims.sessionIssuedAt, row.createdAt)) {
    return { kind: 'anonymous' };
  }
  return { kind: 'guest', userId: row.id, guestId: getGuestIdFromRequest(request) };
}

/**
 * Marks a guest as active before registration begins. The inactive-guest cleanup re-checks
 * `guestLastActiveAt` in its own delete, so a guest touched here is not removed while the
 * registration (password hashing, verification email, promotion) is in progress.
 * Resolves false when the row is no longer a guest.
 */
export async function protectGuestForRegistration(userId: string): Promise<boolean> {
  return recordGuestActivity(userId);
}

export type PromotionInput = {
  userId: string;
  guestId: string | null;
  email: string;
  passwordHash: string;
  name: string | null;
  emailVerified: Date | null;
};

export type PromotionOutcome =
  | {
      status: 'promoted';
      user: { id: string; email: string; name: string | null; role: string };
    }
  /** The row is already an account: a retry or a concurrent request won. */
  | { status: 'already-registered' }
  /** The guest row is gone (cleanup) before the promotion could commit. */
  | { status: 'expired' }
  /** Another account already holds the email (unique constraint on User.email). */
  | { status: 'email-taken' };

function isUniqueEmailViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Promotes the guest row in one transaction. The conditional update `where { id, isGuest: true }`
 * is the only write that changes identity, so of several concurrent promotions of the same guest
 * exactly one commits. The funnel REGISTER is written under the chain lock in the same
 * transaction. A failed commit rolls everything back, so the guest stays a guest.
 */
export async function promoteGuestAccount(input: PromotionInput): Promise<PromotionOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: input.userId, isGuest: true },
        data: {
          email: input.email,
          password: input.passwordHash,
          name: input.name,
          emailVerified: input.emailVerified,
          isGuest: false,
        },
      });

      if (updated.count !== 1) {
        const row = await tx.user.findUnique({
          where: { id: input.userId },
          select: { id: true },
        });
        return { status: row ? 'already-registered' : 'expired' } as const;
      }

      if (input.guestId) {
        await recordGuestPromotionEvent(tx, { userId: input.userId, guestId: input.guestId });
      }

      const user = await tx.user.findUniqueOrThrow({
        where: { id: input.userId },
        select: { id: true, email: true, name: true, role: true },
      });
      return { status: 'promoted', user } as const;
    });
  } catch (error) {
    if (isUniqueEmailViolation(error)) {
      return { status: 'email-taken' };
    }
    throw error;
  }
}

/**
 * Mints the ordinary session that replaces the guest session. Its `sessionIssuedAt` is stamped now,
 * and `isGuest` is false. Old guest tokens for this id still carry `isGuest: true`, and the jwt
 * callback rejects them once the row is no longer a guest.
 */
export async function encodeOrdinarySession(user: {
  id: string;
  role: string;
  email: string;
  name: string | null;
}): Promise<string> {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error('Auth secret is missing');
  }
  return encode({
    token: {
      id: user.id,
      role: user.role,
      email: user.email,
      isGuest: false,
      name: user.name,
      sub: user.id,
      sessionIssuedAt: currentSessionIssuedAtSeconds(),
    },
    secret,
    maxAge: GUEST_SESSION_MAX_AGE_SECONDS,
  });
}

/** Cookie options that match POST /api/auth/guest, so the replacement cookie overwrites it. */
export function sessionCookieFor(request: Pick<Request, 'url' | 'headers'>) {
  const secure = shouldUseSecureSessionCookies(request);
  return {
    name: secure ? NEXTAUTH_SECURE_SESSION_COOKIE : NEXTAUTH_SESSION_COOKIE,
    options: {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure,
      maxAge: GUEST_SESSION_MAX_AGE_SECONDS,
    },
  };
}
