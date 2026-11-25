/**
 * Explicit guest upgrade through Google (AGE-1667). Client-safe: no server imports.
 *
 * An upgrade is its own NextAuth provider, `google-upgrade`, with the same Google client. Its OAuth
 * round trip returns to `/api/auth/callback/google-upgrade`, and NextAuth binds that round trip to
 * the provider id inside its signed state and PKCE cookies (`provider`). So the callback knows the
 * round trip was started as an upgrade by NextAuth itself, not by a browser-set flag or a shared
 * callback URL. An ordinary Google sign-in uses provider `google` and never reaches the upgrade path.
 *
 * The server-side intent that names the guest (guest-promotion.ts) is a signed, httpOnly cookie
 * minted by POST /api/auth/guest-upgrade for the live guest only.
 */
export const GUEST_UPGRADE_PROVIDER_ID = 'google-upgrade';
export const GUEST_UPGRADE_INTENT_COOKIE = 'clickmoji_guest_upgrade';
export const GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS = 300;
