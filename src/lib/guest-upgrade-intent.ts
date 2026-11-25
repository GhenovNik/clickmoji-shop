/**
 * Explicit guest-upgrade intent for Google sign-in (AGE-1667). Client and server share the name.
 *
 * The register page sets this short-lived cookie right before it starts Google sign-in from a guest
 * session. The Google callback reads it (see guest-promotion.ts). Ordinary sign-in never sets it.
 */
export const GUEST_UPGRADE_INTENT_COOKIE = 'clickmoji_guest_upgrade';
export const GUEST_UPGRADE_INTENT_VALUE = 'google';
export const GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS = 300;

export function setGuestUpgradeIntent(): void {
  try {
    const secure = typeof window !== 'undefined' && window.location.protocol === 'https:';
    document.cookie =
      `${GUEST_UPGRADE_INTENT_COOKIE}=${GUEST_UPGRADE_INTENT_VALUE}; Path=/; ` +
      `Max-Age=${GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS}; SameSite=Lax` +
      (secure ? '; Secure' : '');
  } catch {
    // Without cookies the Google button falls back to ordinary sign-in on the server side.
  }
}

export function clearGuestUpgradeIntent(): void {
  try {
    document.cookie = `${GUEST_UPGRADE_INTENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    // Expiry is best effort; the cookie also expires on its own after a few minutes.
  }
}
