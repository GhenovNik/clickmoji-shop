/**
 * Explicit guest upgrade through Google (AGE-1667). Client-safe: no server imports.
 *
 * The upgrade uses the same Google provider id, `google`, and the same registered redirect URI,
 * `/api/auth/callback/google`, as ordinary Google sign-in. Nothing is added to the Google Cloud
 * client. The two flows are told apart on the server only:
 *
 *   1. POST /api/auth/guest-upgrade checks that the caller is a live guest and sets a short-lived
 *      arm cookie (GUEST_UPGRADE_ARM_COOKIE) bound to that guest's User.id.
 *   2. The registration page starts Google with signIn(GOOGLE_PROVIDER_ID, { ...,
 *      [GUEST_UPGRADE_START_FIELD]: GUEST_UPGRADE_START_VALUE }). That field is the explicit start
 *      request, carried in the POST body that next-auth/react sends. POST /api/auth/signin/google
 *      takes the explicit path only when the body names it, and then requires the arm and a live
 *      guest. An ordinary start never reads or consumes the arm, even when the arm is present.
 *      The explicit path consumes the arm and starts Google with its own NextAuth instance. It mints
 *      the intent cookie (GUEST_UPGRADE_INTENT_COOKIE), bound to the guest and to the OAuth `state`
 *      of that round trip.
 *   3. GET /api/auth/callback/google takes the explicit path only when the returned `state` is the
 *      intent's state (or the state of that instance's own round-trip cookie).
 *
 * The request names the start mode, and the signed arm, intent and round-trip cookies prove it.
 */
export const GOOGLE_PROVIDER_ID = 'google';

/**
 * The body field that marks an explicit guest-upgrade start (AGE-1667). next-auth/react sends every
 * signIn option as a form field of the POST, so the register page passes it as an option.
 */
export const GUEST_UPGRADE_START_FIELD = 'guestUpgrade';
export const GUEST_UPGRADE_START_VALUE = 'explicit';

/** Short-lived server-side marker that the next explicit Google start is an upgrade. */
export const GUEST_UPGRADE_ARM_COOKIE = 'clickmoji_guest_upgrade_arm';
export const GUEST_UPGRADE_ARM_MAX_AGE_SECONDS = 120;

/** Signed value that binds one OAuth round trip to the guest and its state. */
export const GUEST_UPGRADE_INTENT_COOKIE = 'clickmoji_guest_upgrade';
export const GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS = 300;
