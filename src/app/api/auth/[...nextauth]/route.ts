import NextAuth, { type NextAuthOptions } from 'next-auth';
import type { NextRequest } from 'next/server';
import { authOptions, guestUpgradeAuthOptions } from '@/lib/auth';
import { shouldUseSecureSessionCookies } from '@/lib/guest';
import {
  mintGuestUpgradeIntent,
  readGuestUpgradeIntent,
  resolveRegistrationGuest,
} from '@/lib/guest-promotion';
import {
  GUEST_UPGRADE_INTENT_COOKIE,
  GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS,
  GUEST_UPGRADE_PROVIDER_ID,
} from '@/lib/guest-upgrade-intent';
import {
  expiredCookieHeader,
  guestUpgradeOAuthCookieNames,
  intentCookieHeader,
} from '@/lib/guest-upgrade-oauth';

/**
 * NextAuth routes (AGE-1667). Every request for the `google-upgrade` provider goes to a separate
 * NextAuth instance with its own round-trip cookies; every other request goes to the ordinary one.
 * The upgrade binds its intent to the OAuth `state` that NextAuth issued for that round trip:
 *   - start (POST signin): the signed intent cookie is set with the guest id and the state in the
 *     authorization URL, so it describes exactly this attempt;
 *   - callback (GET): the request's state must equal the intent's state before NextAuth runs. A
 *     newer attempt's intent therefore refuses an older one, and that refusal does not clear the
 *     newer attempt's cookies.
 * Single use: the promotion itself is one conditional update (see guest-promotion.ts); the round-trip
 * and intent cookies are also cleared on the callback whatever NextAuth decided.
 */

const ordinaryHandler = NextAuth(authOptions);

type RouteContext = { params: Promise<{ nextauth?: string[] }> };

type UpgradeHandler = (request: NextRequest, context: RouteContext) => Promise<Response>;

function expiredRedirect(request: Request): Response {
  return Response.redirect(new URL('/register?upgrade=expired', request.url), 302);
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

async function startGoogleUpgrade(
  request: NextRequest,
  context: RouteContext,
  upgrade: UpgradeHandler,
  secure: boolean
): Promise<Response> {
  const guest = await resolveRegistrationGuest(request);
  if (guest.kind !== 'guest') return expiredRedirect(request);

  const response = await upgrade(request, context);
  if (!response.ok) return response;

  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { url?: unknown } | null;
  let state: string | null = null;
  try {
    state = typeof body?.url === 'string' ? new URL(body.url).searchParams.get('state') : null;
  } catch {
    state = null;
  }
  // No state in the authorization URL: no intent is set, so the callback refuses (fails closed).
  if (!state) return response;

  let value: string;
  try {
    value = await mintGuestUpgradeIntent(guest.userId, state);
  } catch {
    return Response.json({ error: 'guestUpgradeUnavailable' }, { status: 500 });
  }
  return withCookies(response, [
    intentCookieHeader(value, GUEST_UPGRADE_INTENT_MAX_AGE_SECONDS, secure),
  ]);
}

async function finishGoogleUpgrade(
  request: NextRequest,
  context: RouteContext,
  upgrade: UpgradeHandler,
  secure: boolean
): Promise<Response> {
  const intent = await readGuestUpgradeIntent();
  const state = new URL(request.url).searchParams.get('state');
  // The intent names another attempt, or none: refuse without touching the cookies, which may belong
  // to a newer attempt that is still in progress.
  if (!intent || !state || intent.state !== state) return expiredRedirect(request);

  const response = await upgrade(request, context);
  const cleared = [...guestUpgradeOAuthCookieNames(secure), GUEST_UPGRADE_INTENT_COOKIE].map(
    (name) => expiredCookieHeader(name, secure)
  );
  return withCookies(response, cleared);
}

async function dispatch(request: NextRequest, context: RouteContext): Promise<Response> {
  const segments = (await context.params).nextauth ?? [];
  if (segments[1] !== GUEST_UPGRADE_PROVIDER_ID) {
    return ordinaryHandler(request, context);
  }

  const secure = shouldUseSecureSessionCookies(request);
  const options: NextAuthOptions | null = guestUpgradeAuthOptions(secure);
  if (!options) return expiredRedirect(request);
  const upgrade = NextAuth(options) as UpgradeHandler;

  if (segments[0] === 'signin' && request.method === 'POST') {
    return startGoogleUpgrade(request, context, upgrade, secure);
  }
  if (segments[0] === 'callback' && request.method === 'GET') {
    return finishGoogleUpgrade(request, context, upgrade, secure);
  }
  // Any other request for the upgrade provider (a page, a POST callback) starts nothing.
  return expiredRedirect(request);
}

export async function GET(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}
