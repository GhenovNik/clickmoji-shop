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
 * Validates that a NextAuth JWT (`iat` in integer Unix seconds) was issued at or after the user
 * row's creation second. Using second granularity avoids false negatives when `user.createdAt` has
 * sub-second milliseconds in the same second as JWT `iat`.
 */
export function isSessionTokenFreshForUser(
  tokenIssuedAtSeconds: number | undefined,
  userCreatedAt: Date | null | undefined
): boolean {
  if (typeof tokenIssuedAtSeconds !== 'number' || !Number.isFinite(tokenIssuedAtSeconds)) {
    return false;
  }
  if (!(userCreatedAt instanceof Date) || Number.isNaN(userCreatedAt.getTime())) {
    return false;
  }
  return tokenIssuedAtSeconds >= Math.floor(userCreatedAt.getTime() / 1000);
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
