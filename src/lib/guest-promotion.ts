import { cookies } from 'next/headers';
import { decode, encode } from 'next-auth/jwt';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  currentSessionIssuedAtSeconds,
  GUEST_SESSION_MAX_AGE_SECONDS,
  isSessionTokenFreshForUser,
  NEXTAUTH_SECURE_SESSION_COOKIE,
  NEXTAUTH_SESSION_COOKIE,
  shouldUseSecureSessionCookies,
} from '@/lib/guest';
import {
  getGuestIdFromRequest,
  readGuestIdFromRequestScope,
  recordGuestPromotionEvent,
} from '@/lib/funnel';
import { recordGuestActivity } from '@/lib/guest-activity';
import {
  GUEST_UPGRADE_INTENT_COOKIE,
  GUEST_UPGRADE_INTENT_VALUE,
} from '@/lib/guest-upgrade-intent';

/**
 * In-place promotion of a server-backed guest into an ordinary account (AGE-1667).
 *
 * The guest's User row keeps its id, so lists, items, purchases, history and favorites keep their
 * owner. Only the identity columns change (email, password or Google identity, name, emailVerified)
 * and isGuest flips to false, in one conditional update `where { id, isGuest: true }`. No second row
 * is created, no accounts are merged and no starter lists are re-created. See docs/guest-shopping.md.
 */

type SessionClaims = {
  id?: unknown;
  isGuest?: unknown;
  sessionIssuedAt?: unknown;
};

function getAuthSecret(): string | null {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || null;
}

async function decodeSessionCookie(value: string | undefined): Promise<SessionClaims | null> {
  const secret = getAuthSecret();
  if (!secret || !value) return null;
  try {
    const claims = await decode({ token: value, secret });
    return claims ? (claims as SessionClaims) : null;
  } catch {
    // A malformed or foreign cookie is not a guest session.
    return null;
  }
}

/**
 * Reads the NextAuth session cookie of a request and verifies its signature. Returns null when there
 * is no cookie, no secret or an invalid token. It does not consult the database: callers do that.
 */
export async function readSessionClaimsFromRequest(
  request: Pick<Request, 'headers'>
): Promise<SessionClaims | null> {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;

  const names = new Set([NEXTAUTH_SESSION_COOKIE, NEXTAUTH_SECURE_SESSION_COOKIE]);
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!names.has(name)) continue;
    const claims = await decodeSessionCookie(part.slice(separator + 1).trim());
    if (claims) return claims;
  }
  return null;
}

/**
 * What a registration request may do with the guest session it carries:
 * - `guest`: a live guest row with a fresh token. Registration promotes that row.
 * - `promoted`: a guest token whose row is already an account (a retry, a second tab). Registration
 *   is refused, so one browser never opens a second account for the same guest.
 * - `stale`: a signed guest token whose row was removed by cleanup, or no longer matches the token's
 *   issuance. Registration fails with `guestSessionExpired` instead of silently creating a second
 *   account, and the stale cookie is cleared so the next attempt starts from a clean session.
 * - `anonymous`: no guest session at all. Registration creates an ordinary account, as for any visitor.
 */
export type RegistrationGuestState =
  | { kind: 'anonymous' }
  | { kind: 'promoted' }
  | { kind: 'stale' }
  | { kind: 'guest'; userId: string; guestId: string | null };

async function resolveGuestClaims(
  claims: SessionClaims | null,
  guestId: string | null
): Promise<RegistrationGuestState> {
  if (!claims || claims.isGuest !== true || typeof claims.id !== 'string' || !claims.id) {
    return { kind: 'anonymous' };
  }

  const row = await prisma.user.findUnique({
    where: { id: claims.id },
    select: { id: true, isGuest: true, createdAt: true },
  });
  if (!row) return { kind: 'stale' };
  if (!row.isGuest) return { kind: 'promoted' };
  if (!isSessionTokenFreshForUser(claims.sessionIssuedAt, row.createdAt)) {
    return { kind: 'stale' };
  }
  return { kind: 'guest', userId: row.id, guestId };
}

/** Resolves the guest session carried by a registration request (email/password path). */
export async function resolveRegistrationGuest(
  request: Pick<Request, 'headers'>
): Promise<RegistrationGuestState> {
  const claims = await readSessionClaimsFromRequest(request);
  return resolveGuestClaims(claims, getGuestIdFromRequest(request));
}

/**
 * Resolves the guest session held by the browser during a Google OAuth callback. The callback has no
 * request object, so the session cookie is read from the request scope. A stale token is reported as
 * `stale` here too, but the Google path treats it as no guest (see auth.ts): it only blocks
 * registration, never a sign-in.
 */
export async function resolveGuestFromCookieStore(): Promise<RegistrationGuestState> {
  let store: Awaited<ReturnType<typeof cookies>>;
  try {
    store = await cookies();
  } catch {
    return { kind: 'anonymous' };
  }
  const value =
    store.get(NEXTAUTH_SECURE_SESSION_COOKIE)?.value ?? store.get(NEXTAUTH_SESSION_COOKIE)?.value;
  const claims = await decodeSessionCookie(value);
  return resolveGuestClaims(claims, await readGuestIdFromRequestScope());
}

/**
 * Marks a guest as active before a promotion begins. The inactive-guest cleanup re-checks
 * `guestLastActiveAt` in its own delete, so a guest touched here is not removed while the
 * registration (password hashing, verification email, promotion) is in progress.
 * Resolves false when the row is no longer a guest.
 */
export async function protectGuestForRegistration(userId: string): Promise<boolean> {
  return recordGuestActivity(userId);
}

/** Thrown inside a promotion transaction when the verification email cannot be sent. */
export class VerificationDeliveryError extends Error {
  constructor() {
    super('Verification email delivery failed');
    this.name = 'VerificationDeliveryError';
  }
}

export type PromotionInput = {
  userId: string;
  guestId: string | null;
  email: string;
  /** Null for a Google identity, which has no local password. */
  passwordHash: string | null;
  name: string | null;
  image?: string | null;
  emailVerified: Date | null;
  /**
   * Runs inside the promotion transaction after the conditional update succeeded and before commit.
   * A throw rolls the whole promotion back, so anything it writes (a verification token) and the
   * guest row are both left as they were.
   */
  beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
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
  | { status: 'email-taken' }
  /** The verification email could not be sent; nothing was promoted or kept. */
  | { status: 'delivery-failed' };

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
 * exactly one commits, and a unique-email conflict rolls the promotion back. The funnel
 * GUEST_REGISTERED is written in the same transaction, once per committed promotion.
 */
export async function promoteGuestAccount(input: PromotionInput): Promise<PromotionOutcome> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: input.userId, isGuest: true },
          data: {
            email: input.email,
            password: input.passwordHash,
            name: input.name,
            ...(input.image !== undefined ? { image: input.image } : {}),
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

        if (input.beforeCommit) {
          try {
            await input.beforeCommit(tx);
          } catch (error) {
            if (error instanceof VerificationDeliveryError) throw error;
            throw new VerificationDeliveryError();
          }
        }

        await recordGuestPromotionEvent(tx, { userId: input.userId, guestId: input.guestId });

        const user = await tx.user.findUniqueOrThrow({
          where: { id: input.userId },
          select: { id: true, email: true, name: true, role: true },
        });
        return { status: 'promoted', user } as const;
      },
      { timeout: 15_000, maxWait: 5_000 }
    );
  } catch (error) {
    if (error instanceof VerificationDeliveryError) {
      return { status: 'delivery-failed' };
    }
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

/** Cookie name and options that match POST /api/auth/guest, so a replacement overwrites it. */
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

/**
 * Promotes a guest in place with a verified Google identity (AGE-1667). Google has already verified
 * the address, so emailVerified is set now and no verification email is sent. The caller checks
 * `email_verified` and that no account holds the email yet; the unique email constraint still
 * settles a race. A guest that cleanup removed in the meantime yields `expired`.
 */
export async function promoteGuestWithGoogleIdentity(input: {
  userId: string;
  guestId: string | null;
  email: string;
  name: string | null;
  image: string | null;
}): Promise<PromotionOutcome> {
  const active = await protectGuestForRegistration(input.userId);
  if (!active) return { status: 'expired' };
  return promoteGuestAccount({
    userId: input.userId,
    guestId: input.guestId,
    email: input.email,
    passwordHash: null,
    name: input.name,
    image: input.image,
    emailVerified: new Date(),
  });
}

/**
 * Explicit upgrade intent (AGE-1667). The register page sets this short-lived, non-secret cookie
 * right before it starts Google sign-in from the guest's "save account" action. Only a request that
 * carries it may promote a guest through Google. Ordinary Google sign-in never reads it and keeps its
 * own behaviour (sign into the matching account or create one), so a guest's Google login cannot
 * silently convert the guest row.
 *
 * A forged cookie can only select the stricter explicit path: it never grants a promotion the guest
 * session does not already hold.
 */
export async function readGuestUpgradeIntent(): Promise<boolean> {
  try {
    const store = await cookies();
    return store.get(GUEST_UPGRADE_INTENT_COOKIE)?.value === GUEST_UPGRADE_INTENT_VALUE;
  } catch {
    return false;
  }
}

/**
 * Outcome of an explicit guest upgrade through Google. The non-promoted statuses are reported back to
 * the register page as `?upgrade=<status>`, and no session is issued for them.
 * - `email-taken`: another account holds the address. No switch or merge; the user is told to sign in.
 * - `unverified`: Google did not verify the address. The guest stays a guest.
 * - `expired`: the guest session is stale, already an account, or its row is gone.
 */
export type GoogleUpgradeOutcome =
  | {
      status: 'promoted';
      user: { id: string; email: string; name: string | null; role: string };
    }
  | { status: 'email-taken' }
  | { status: 'unverified' }
  | { status: 'expired' };

/**
 * Runs an explicit guest upgrade for a Google identity. Every refusal leaves the guest row untouched
 * and creates no user. `guest` must come from resolveGuestFromCookieStore(); an anonymous caller never
 * reaches this function (the auth callback falls back to ordinary sign-in for it).
 */
export async function upgradeGuestWithGoogle(input: {
  guest: RegistrationGuestState;
  email: string;
  emailVerified: boolean;
  existingUserId: string | null;
  name: string | null;
  image: string | null;
}): Promise<GoogleUpgradeOutcome> {
  if (input.guest.kind !== 'guest') return { status: 'expired' };
  if (input.existingUserId) return { status: 'email-taken' };
  if (!input.emailVerified) return { status: 'unverified' };

  const outcome = await promoteGuestWithGoogleIdentity({
    userId: input.guest.userId,
    guestId: input.guest.guestId,
    email: input.email,
    name: input.name,
    image: input.image,
  });
  switch (outcome.status) {
    case 'promoted':
      return { status: 'promoted', user: outcome.user };
    case 'email-taken':
      return { status: 'email-taken' };
    default:
      return { status: 'expired' };
  }
}

/** Expires the guest session cookie on the response, so the old guest token is no longer sent. */
export function clearSessionCookie(
  response: { cookies: { set: (name: string, value: string, options: object) => unknown } },
  request: Pick<Request, 'url' | 'headers'>
) {
  const cookie = sessionCookieFor(request);
  response.cookies.set(cookie.name, '', {
    ...cookie.options,
    maxAge: 0,
    expires: new Date(0),
  });
}
