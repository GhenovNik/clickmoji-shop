/**
 * Explicit guest upgrade through Google (AGE-1667). Client-safe: no server imports.
 *
 * The upgrade uses the same Google provider id, `google`, and the same registered redirect URI,
 * `/api/auth/callback/google`, as ordinary Google sign-in. Nothing is added to the Google Cloud
 * client. The two flows are told apart on the server only:
 *
 *   1. POST /api/auth/guest-upgrade checks that the caller is a live guest and sets a short-lived
 *      arm cookie (GUEST_UPGRADE_ARM_COOKIE) bound to that guest's User.id.
 *   2. POST /api/auth/signin/google takes the explicit path only while that arm cookie is present.
 *      The arm is consumed there. The explicit path then starts Google with its own NextAuth
 *      instance and mints the intent cookie (GUEST_UPGRADE_INTENT_COOKIE), bound to the guest and to
 *      the OAuth `state` of that round trip.
 *   3. GET /api/auth/callback/google takes the explicit path only when the returned `state` is the
 *      intent's state (or the state of that instance's own round-trip cookie).
 *
 * The browser never names the mode: the arm, the intent and the signed round-trip cookies do.
 */
export const GOOGLE_PROVIDER_ID = 'google';

/** Short-lived server-side marker that the next Google sign-in start is an explicit upgrade. */
export const GUEST_UPGRADE_ARM_COOKIE = 'clickmoji_guest_upgrade_arm';
export const GUEST_UPGRADE_ARM_MAX_AGE_SECONDS = 120;

/** Signed value that binds one OAuth round trip to the guest and its state. */
export const GUEST_UPGRADE_INTENT_COOKIE = 'clickmoji_guest_upgrade';
export const GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS = 300;
