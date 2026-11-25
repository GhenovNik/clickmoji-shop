import { GUEST_UPGRADE_INTENT_COOKIE } from '@/lib/guest-upgrade-intent';

/**
 * Cookie set of the explicit guest upgrade's own NextAuth instance (AGE-1667).
 *
 * NextAuth names its OAuth state, PKCE verifier and callback-url cookies with one fixed name per
 * browser, whatever the provider. An ordinary Google start and an upgrade start therefore overwrite
 * each other, and the first callback then fails. The upgrade instance keeps the same session and
 * CSRF cookies (one browser, one session) but moves its round-trip cookies into their own namespace,
 * so each flow keeps its own state, PKCE verifier and callback url until it completes.
 */
export const GUEST_UPGRADE_OAUTH_NAMESPACE = 'next-auth.guest-upgrade';

const ROUND_TRIP_MAX_AGE_SECONDS = 60 * 15;

/** The full cookie set of the upgrade instance. Every entry is given, because NextAuth replaces
 * the default cookie object as a whole, never field by field. */
export function guestUpgradeOAuthCookies(secure: boolean) {
  const prefix = secure ? '__Secure-' : '';
  const base = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure };
  const roundTrip = { ...base, maxAge: ROUND_TRIP_MAX_AGE_SECONDS };
  return {
    sessionToken: { name: `${prefix}next-auth.session-token`, options: base },
    csrfToken: { name: `${secure ? '__Host-' : ''}next-auth.csrf-token`, options: base },
    callbackUrl: { name: `${prefix}${GUEST_UPGRADE_OAUTH_NAMESPACE}.callback-url`, options: base },
    state: { name: `${prefix}${GUEST_UPGRADE_OAUTH_NAMESPACE}.state`, options: roundTrip },
    pkceCodeVerifier: {
      name: `${prefix}${GUEST_UPGRADE_OAUTH_NAMESPACE}.pkce.code_verifier`,
      options: roundTrip,
    },
    nonce: { name: `${prefix}${GUEST_UPGRADE_OAUTH_NAMESPACE}.nonce`, options: base },
  };
}

/** The round-trip cookie names of the upgrade instance, for clearing them after the callback. */
export function guestUpgradeOAuthCookieNames(secure: boolean): string[] {
  const cookies = guestUpgradeOAuthCookies(secure);
  return [
    cookies.state.name,
    cookies.pkceCodeVerifier.name,
    cookies.callbackUrl.name,
    cookies.nonce.name,
  ];
}

/** A Set-Cookie header value that expires `name` on the browser. */
export function expiredCookieHeader(name: string, secure: boolean): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** A Set-Cookie header value for the signed guest-upgrade intent (AGE-1667). */
export function intentCookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${GUEST_UPGRADE_INTENT_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
