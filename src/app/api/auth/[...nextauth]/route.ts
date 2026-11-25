import NextAuth, { type NextAuthOptions } from 'next-auth';
import { decode } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';
import { authOptions, guestUpgradeAuthOptions } from '@/lib/auth';
import { shouldUseSecureSessionCookies } from '@/lib/guest';
import {
  mintGuestUpgradeArm,
  mintGuestUpgradeIntent,
  readGuestUpgradeArm,
  readGuestUpgradeIntent,
  resolveRegistrationGuest,
} from '@/lib/guest-promotion';
import {
  GOOGLE_PROVIDER_ID,
  GUEST_UPGRADE_ARM_COOKIE,
  GUEST_UPGRADE_INTENT_COOKIE,
  GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS,
  GUEST_UPGRADE_START_FIELD,
  GUEST_UPGRADE_START_VALUE,
} from '@/lib/guest-upgrade-intent';
import {
  expiredCookieHeader,
  guestUpgradeOAuthCookieNames,
  guestUpgradeStateCookieName,
  intentCookieHeader,
} from '@/lib/guest-upgrade-oauth';

/**
 * NextAuth routes (AGE-1667). The explicit guest upgrade uses the same Google provider and redirect
 * URI as ordinary sign-in, so the server tells the two apart by what each request carries:
 *
 *   - Start (POST /api/auth/signin/google). Explicit only when the form body names the start (the
 *     GUEST_UPGRADE_START_FIELD option that the register page passes to signIn). The explicit start
 *     requires the server-side arm cookie (set by POST /api/auth/guest-upgrade for a live guest) and
 *     consumes it. It runs the upgrade NextAuth instance and binds an intent cookie to the guest's
 *     User.id and to the OAuth `state` in the authorization URL. Any refusal is returned as JSON,
 *     never as an ordinary start. Every other POST is ordinary: it runs the ordinary instance and
 *     does not read, consume or update the arm.
 *   - Callback (GET /api/auth/callback/google). The request's `state` decides the mode. It is explicit
 *     when it equals the intent's state, or the state of the upgrade instance's own round-trip cookie.
 *     An explicit callback whose intent is missing or names another attempt is refused, and nothing
 *     falls through to ordinary sign-up. Any other callback is ordinary, so an ordinary sign-in is
 *     never refused because an upgrade started (or the reverse).
 *
 * Single use: the promotion itself is one conditional update (see guest-promotion.ts). The round-trip,
 * arm and intent cookies are cleared on every explicit exit: success, refusal and cancellation.
 */

const ordinaryHandler = NextAuth(authOptions);

type RouteContext = { params: Promise<{ nextauth?: string[] }> };

type UpgradeHandler = (request: NextRequest, context: RouteContext) => Promise<Response>;

const REGISTER_EXPIRED_PATH = '/register?upgrade=expired';

/** A callback refusal: a redirect, as NextAuth's own callback refusals are. */
function expiredRedirect(request: Request): Response {
  return Response.redirect(new URL(REGISTER_EXPIRED_PATH, request.url), 302);
}

/**
 * A start refusal. The NextAuth client reads `url` from the JSON and navigates there; a redirect
 * would be followed by fetch and break its JSON read.
 */
function expiredStartJson(request: Request): Response {
  return Response.json({ url: new URL(REGISTER_EXPIRED_PATH, request.url).toString() });
}

function withCookies(response: Response, cookies: string[]): Response {
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The `state` that NextAuth put into the authorization URL of this start, or null. */
async function authorizationState(response: Response): Promise<string | null> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { url?: unknown } | null;
  try {
    return typeof body?.url === 'string' ? new URL(body.url).searchParams.get('state') : null;
  } catch {
    return null;
  }
}

/**
 * The OAuth state held by the upgrade instance's own round-trip cookie, read from the request. It
 * is a NextAuth JWE of `{ value: state, provider }` salted with the cookie name. Null when absent,
 * malformed or not verifiable with this secret.
 */
async function upgradeRoundTripState(
  request: NextRequest,
  secure: boolean
): Promise<string | null> {
  const name = guestUpgradeStateCookieName(secure);
  const token = request.cookies.get(name)?.value;
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!token || !secret) return null;
  try {
    const claims = (await decode({ token, secret, salt: name })) as { value?: unknown } | null;
    return typeof claims?.value === 'string' ? claims.value : null;
  } catch {
    return null;
  }
}

/**
 * Whether the POST body names the explicit start. The body is read from a clone, so the request that
 * NextAuth receives is left intact. An unreadable body is an ordinary start.
 */
async function requestsExplicitStart(request: NextRequest): Promise<boolean> {
  const form = await request.clone().text().catch(() => '');
  return new URLSearchParams(form).get(GUEST_UPGRADE_START_FIELD) === GUEST_UPGRADE_START_VALUE;
}

/**
 * Explicit start. The arm must be fresh, and the caller must still be the live guest it names. Any
 * refusal returns `expired` JSON with the arm cleared, and never an ordinary start.
 */
async function startGoogleUpgrade(
  request: NextRequest,
  context: RouteContext,
  secure: boolean
): Promise<Response> {
  const clearArm = expiredCookieHeader(GUEST_UPGRADE_ARM_COOKIE, secure);
  const arm = await readGuestUpgradeArm(request.cookies.get(GUEST_UPGRADE_ARM_COOKIE)?.value);
  const guest = await resolveRegistrationGuest(request);
  const options: NextAuthOptions | null = guestUpgradeAuthOptions(secure);
  if (!arm || !options || guest.kind !== 'guest' || guest.userId !== arm.guestUserId) {
    return withCookies(expiredStartJson(request), [clearArm]);
  }

  const upgrade = NextAuth(options) as UpgradeHandler;
  const response = await upgrade(request, context);
  if (!response.ok) return withCookies(response, [clearArm]);

  const state = await authorizationState(response);
  // No state in the authorization URL: no intent is set, so the start fails closed.
  if (!state) return withCookies(expiredStartJson(request), [clearArm]);

  let value: string;
  try {
    value = await mintGuestUpgradeIntent(guest.userId, state);
  } catch {
    return Response.json({ error: 'guestUpgradeUnavailable' }, { status: 500 });
  }
  return withCookies(response, [
    intentCookieHeader(value, GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS, secure),
    clearArm,
  ]);
}

/**
 * Callback of an explicit round trip. The intent must name this round trip's state. A callback whose
 * intent is missing or names another attempt is refused. Cookies are cleared only when that refusal
 * belongs to this attempt (no intent left); a newer attempt's intent is never touched.
 */
async function finishGoogleUpgrade(
  request: NextRequest,
  context: RouteContext,
  upgrade: UpgradeHandler,
  secure: boolean,
  intentState: string | null
): Promise<Response> {
  const state = new URL(request.url).searchParams.get('state');
  if (!intentState || intentState !== state) {
    const belongsToThisAttempt = intentState === null;
    const cleared = belongsToThisAttempt
      ? guestUpgradeOAuthCookieNames(secure).map((name) => expiredCookieHeader(name, secure))
      : [];
    return withCookies(expiredRedirect(request), cleared);
  }

  const response = await upgrade(request, context);
  const cleared = [...guestUpgradeOAuthCookieNames(secure), GUEST_UPGRADE_INTENT_COOKIE].map(
    (name) => expiredCookieHeader(name, secure)
  );
  return withCookies(response, cleared);
}

async function dispatch(request: NextRequest, context: RouteContext): Promise<Response> {
  const segments = (await context.params).nextauth ?? [];
  const isGoogle = segments[1] === GOOGLE_PROVIDER_ID;
  const secure = shouldUseSecureSessionCookies(request);

  if (isGoogle && segments[0] === 'signin' && request.method === 'POST') {
    // Ordinary unless the body names the explicit start. An armed cookie alone changes nothing here.
    if (!(await requestsExplicitStart(request))) return ordinaryHandler(request, context);
    return startGoogleUpgrade(request, context, secure);
  }

  if (isGoogle && segments[0] === 'callback' && request.method === 'GET') {
    const requestState = new URL(request.url).searchParams.get('state');
    const intent = await readGuestUpgradeIntent();
    const roundTripState = await upgradeRoundTripState(request, secure);
    const explicit =
      Boolean(requestState) && (intent?.state === requestState || roundTripState === requestState);
    if (!explicit) return ordinaryHandler(request, context);

    // Never the ordinary instance: without the upgrade instance, the explicit round trip is refused.
    const options = guestUpgradeAuthOptions(secure);
    if (!options) return expiredRedirect(request);
    const upgrade = NextAuth(options) as UpgradeHandler;
    return finishGoogleUpgrade(request, context, upgrade, secure, intent?.state ?? null);
  }

  return ordinaryHandler(request, context);
}

export async function GET(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}
