import crypto from 'node:crypto';

export const GUEST_EMAIL_DOMAIN = 'guest.clickmoji.invalid';
export const GUEST_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const GUEST_ACTIVITY_TOUCH_INTERVAL_MS = 60 * 1000;

export const NEXTAUTH_SESSION_COOKIE = 'next-auth.session-token';
export const NEXTAUTH_SECURE_SESSION_COOKIE = '__Secure-next-auth.session-token';

/** Builds a unique non-routable RFC 2606 placeholder email for a server-backed guest user. */
export function buildGuestPlaceholderEmail(): string {
  return `guest_${crypto.randomUUID()}@${GUEST_EMAIL_DOMAIN}`;
}

/** Identifies synthetic guest placeholder addresses so no outbound email is ever sent to them. */
export function isGuestEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false;
  return email.trim().toLowerCase().endsWith(`@${GUEST_EMAIL_DOMAIN}`);
}

/**
 * Seconds since epoch for the immutable `sessionIssuedAt` claim. It is stamped once at initial
 * issuance (sign-in or guest creation) and copied unchanged by every refresh. NextAuth's standard
 * `iat` is not usable for this: it is rewritten each time the token is re-packed.
 */
export function currentSessionIssuedAtSeconds(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000);
}

/** True only for a positive integer issuance claim; anything else marks the token incomplete. */
export function isSessionIssuedAtClaim(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validates that a session's immutable issuance claim (integer Unix seconds) was issued at or after
 * the user row's creation second. Second granularity avoids false negatives when `user.createdAt`
 * has sub-second milliseconds in the same second as the claim.
 */
export function isSessionTokenFreshForUser(
  sessionIssuedAtSeconds: unknown,
  userCreatedAt: Date | null | undefined
): boolean {
  if (!isSessionIssuedAtClaim(sessionIssuedAtSeconds)) {
    return false;
  }
  if (!(userCreatedAt instanceof Date) || Number.isNaN(userCreatedAt.getTime())) {
    return false;
  }
  return sessionIssuedAtSeconds >= Math.floor(userCreatedAt.getTime() / 1000);
}

/**
 * Matches NextAuth's session cookie security naming so `getServerSession` and `getToken` read the
 * cookie minted by `POST /api/auth/guest` in both local HTTP and HTTPS/Vercel deployments.
 */
export function shouldUseSecureSessionCookies(request: Pick<Request, 'url' | 'headers'>): boolean {
  const configuredUrl = process.env.NEXTAUTH_URL || process.env.AUTH_URL;
  if (configuredUrl) {
    return configuredUrl.startsWith('https://');
  }
  if (process.env.VERCEL) {
    return true;
  }
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    return forwardedProto.split(',')[0].trim() === 'https';
  }
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}
