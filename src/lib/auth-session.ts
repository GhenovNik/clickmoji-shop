/**
 * Shared, DB-free check of the NextAuth JWT claims this app relies on.
 * Kept free of Prisma so the edge-facing proxy can import it.
 *
 * `authIssuedAt` is written once at sign-in in milliseconds. NextAuth's own `iat`
 * is in seconds and is replaced on every re-encode, so it cannot prove when the
 * account session was first granted.
 */
export const SESSION_ISSUED_AT_CLAIM = 'authIssuedAt';

const CLOCK_SKEW_MS = 60_000;
// Anything earlier is not a millisecond timestamp of this app (e.g. a seconds value).
const EARLIEST_ISSUED_AT_MS = Date.UTC(2020, 0, 1);

export type SessionClaims = { id: string; authIssuedAt: number };

/** Returns the claims of a well-formed session token, or null. Legacy tokens yield null. */
export function readSessionClaims(token: unknown, now = Date.now()): SessionClaims | null {
  if (!token || typeof token !== 'object') {
    return null;
  }

  const { id, authIssuedAt } = token as Record<string, unknown>;

  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }

  if (
    typeof authIssuedAt !== 'number' ||
    !Number.isSafeInteger(authIssuedAt) ||
    authIssuedAt < EARLIEST_ISSUED_AT_MS ||
    authIssuedAt > now + CLOCK_SKEW_MS
  ) {
    return null;
  }

  return { id, authIssuedAt };
}
