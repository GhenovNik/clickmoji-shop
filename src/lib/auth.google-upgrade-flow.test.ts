// @vitest-environment node
//
// Ordinary Google sign-in and the explicit guest upgrade (AGE-1667), run through the real route
// handlers of src/app/api/auth/[...nextauth]/route.ts and the installed NextAuth: its real state,
// PKCE and round-trip cookies, its real callback and session handling. Doubles stand in only for
// what is outside the process: Google's token and profile endpoints (network), the database (an
// in-memory table with the same conditional-update semantics) and the request's cookie store.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { decode, encode } from 'next-auth/jwt';

const world = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  process.env.AUTH_SECRET = 'test-secret-for-google-upgrade-flow';
  process.env.NEXTAUTH_URL = 'http://localhost:3000';
  return {
    cookieHeader: '',
    headers: new Headers(),
    requestCookieStore: null as null | (() => unknown),
    users: new Map<string, Record<string, unknown>>(),
    /** The profile Google returns for the next callback (set per test). */
    profile: null as null | { sub: string; email: string; email_verified: boolean; name: string },
    /** PKCE challenge of each authorization request, by its state, as Google would hold it. */
    challenges: new Map<string, string>(),
  };
});

/** Like next/headers cookies(): values are decoded (NextAuth stores its callback URL percent-encoded). */
function requestCookieStore() {
  const jar = new Map<string, string>();
  for (const part of world.cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  };
}

vi.mock('next/headers', () => ({
  cookies: async () => requestCookieStore(),
  headers: async () => world.headers,
}));

vi.mock('@/lib/email', () => ({ isEmailVerificationRequired: () => false }));

vi.mock('@/lib/funnel', () => ({
  readGuestIdFromRequestScope: async () => null,
  getGuestIdFromRequest: () => null,
  recordFunnelEvent: async () => undefined,
  recordGuestPromotionEvent: async () => undefined,
}));

vi.mock('@/lib/prisma', () => {
  type Where = Record<string, unknown>;
  type Row = Record<string, unknown>;
  const matches = (row: Row, where: Where) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const find = (where: Where) => [...world.users.values()].find((row) => matches(row, where));
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: Where }) => {
        const row = find(where);
        return row ? { ...row } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: Where }) => {
        const row = find(where);
        if (!row) throw new Error('not found');
        return { ...row };
      },
      create: async ({ data }: { data: Row }) => {
        const row: Row = {
          id: `user-${world.users.size + 1}`,
          role: 'USER',
          isGuest: false,
          image: null,
          password: null,
          emailVerified: null,
          guestLastActiveAt: null,
          createdAt: new Date(),
          ...data,
        };
        world.users.set(row.id as string, row);
        return { ...row };
      },
      update: async ({ where, data }: { where: Where; data: Row }) => {
        const row = find(where);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Where; data: Row }) => {
        const rows = [...world.users.values()].filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
  };
  return { prisma };
});

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  // Only the Google endpoints go offline: no discovery document, a local token and profile step
  // that checks the state and PKCE values exactly as openid-client does in production.
  const offline = <T extends { id: string }>(provider: T): T => {
    if (provider.id !== 'google' && provider.id !== 'google-upgrade') return provider;
    return {
      ...provider,
      wellKnown: undefined,
      issuer: 'https://accounts.google.com',
      idToken: false,
      authorization: {
        url: 'https://accounts.google.com/o/oauth2/v2/auth',
        params: { scope: 'openid email profile' },
      },
      token: {
        url: 'https://oauth2.googleapis.com/token',
        request: async ({
          params,
          checks,
        }: {
          params: Record<string, string>;
          checks: Record<string, string>;
        }) => {
          const { generators } = await import('openid-client');
          if (!params.code) throw new Error('no authorization code');
          if (!checks.state || params.state !== checks.state) throw new Error('state mismatch');
          const challenge = world.challenges.get(checks.state);
          if (
            !checks.code_verifier ||
            generators.codeChallenge(checks.code_verifier) !== challenge
          ) {
            throw new Error('pkce mismatch');
          }
          return { tokens: { access_token: 'google-access-token', token_type: 'Bearer' } };
        },
      },
      userinfo: {
        url: 'https://openidconnect.googleapis.com/v1/userinfo',
        request: async () => {
          if (!world.profile) throw new Error('no Google profile for this test');
          return world.profile;
        },
      },
    } as T;
  };
  return {
    ...actual,
    authOptions: { ...actual.authOptions, providers: actual.authOptions.providers!.map(offline) },
    guestUpgradeAuthOptions: (secure: boolean) => {
      const options = actual.guestUpgradeAuthOptions(secure);
      return options && { ...options, providers: options.providers!.map(offline) };
    },
  };
});

// NextAuth's app-router handler reads the request's cookies with require('next/headers'), a CommonJS
// load that vi.mock does not reach. Its export is replaced here with the same request store.
const nodeRequire = createRequire(import.meta.url);
const nextHeaders = nodeRequire('next/headers') as Record<string, unknown>;
const originalCookies = nextHeaders.cookies;
const originalHeaders = nextHeaders.headers;
Object.defineProperty(nextHeaders, 'cookies', {
  value: async () => requestCookieStore(),
  configurable: true,
  writable: true,
});
Object.defineProperty(nextHeaders, 'headers', {
  value: async () => world.headers,
  configurable: true,
  writable: true,
});
afterAll(() => {
  Object.defineProperty(nextHeaders, 'cookies', {
    value: originalCookies,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(nextHeaders, 'headers', {
    value: originalHeaders,
    configurable: true,
    writable: true,
  });
});

const { GET, POST } = await import('@/app/api/auth/[...nextauth]/route');
const { GUEST_UPGRADE_INTENT_COOKIE } = await import('@/lib/guest-upgrade-intent');

const SECRET = 'test-secret-for-google-upgrade-flow';
const BASE = 'http://localhost:3000';
const ORDINARY_STATE = 'next-auth.state';
const UPGRADE_STATE = 'next-auth.guest-upgrade.state';
const UPGRADE_PKCE = 'next-auth.guest-upgrade.pkce.code_verifier';
const UPGRADE_CALLBACK_URL = 'next-auth.guest-upgrade.callback-url';

type Jar = Map<string, string>;

/** Applies Set-Cookie headers the way a browser does: cleared cookies are removed. */
function absorb(jar: Jar, response: Response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const cleared = value === '' || attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
    if (cleared) jar.delete(name);
    else jar.set(name, value);
  }
}

async function send(
  jar: Jar,
  method: 'GET' | 'POST',
  path: string,
  form?: Record<string, string>
): Promise<Response> {
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const headers = new Headers({ cookie });
  let body: string | undefined;
  if (form) {
    headers.set('content-type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(form).toString();
  }
  world.cookieHeader = cookie;
  world.headers = headers;
  const url = new URL(path, BASE);
  const request = new NextRequest(url, { method, headers, body });
  const nextauth = url.pathname
    .replace(/^\/api\/auth\/?/, '')
    .split('/')
    .filter(Boolean);
  const context = { params: Promise.resolve({ nextauth }) };
  const response = method === 'POST' ? await POST(request, context) : await GET(request, context);
  absorb(jar, response);
  return response;
}

async function csrf(jar: Jar): Promise<string> {
  const response = await send(jar, 'GET', '/api/auth/csrf');
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

/** Starts a round trip the way next-auth/react's signIn does: POST signin, then Google's URL. */
async function startSignIn(jar: Jar, provider: string) {
  const csrfToken = await csrf(jar);
  const response = await send(jar, 'POST', `/api/auth/signin/${provider}`, {
    csrfToken,
    callbackUrl: '/',
    json: 'true',
  });
  if (response.status !== 200) return { response, state: null as string | null };
  const { url } = (await response.json()) as { url: string };
  const authorization = new URL(url);
  const state = authorization.searchParams.get('state');
  if (state) world.challenges.set(state, authorization.searchParams.get('code_challenge') ?? '');
  return { response, state };
}

/** Google's redirect back to the app for one round trip. */
function finishSignIn(
  jar: Jar,
  provider: string,
  state: string | null,
  extra: Record<string, string> = {}
) {
  const query = new URLSearchParams(
    state === null ? extra : { code: 'authorization-code', state, ...extra }
  );
  return send(jar, 'GET', `/api/auth/callback/${provider}?${query.toString()}`);
}

async function sessionSubjectOf(response: Response): Promise<string | null> {
  const line = response.headers
    .getSetCookie()
    .find((c) => c.startsWith('next-auth.session-token='));
  if (!line) return null;
  const token = line.slice('next-auth.session-token='.length).split(';')[0];
  const claims = await decode({ token, secret: SECRET });
  return (claims?.sub as string | undefined) ?? null;
}

async function guestSession(id: string): Promise<string> {
  return encode({
    token: {
      id,
      sub: id,
      isGuest: true,
      role: 'USER',
      email: `guest_${id}@guest.invalid`,
      sessionIssuedAt: Math.floor(Date.now() / 1000) - 30,
    },
    secret: SECRET,
    maxAge: 3600,
  });
}

function seedUser(id: string, email: string) {
  world.users.set(id, {
    id,
    email,
    name: 'Alex',
    image: null,
    role: 'USER',
    password: null,
    isGuest: false,
    emailVerified: new Date(),
    createdAt: new Date(Date.now() - 86_400_000),
    guestLastActiveAt: null,
  });
}

async function seedGuest(jar: Jar, id = 'guest-1') {
  world.users.set(id, {
    id,
    email: `guest_${id}@guest.invalid`,
    name: null,
    image: null,
    role: 'USER',
    password: null,
    isGuest: true,
    emailVerified: null,
    createdAt: new Date(Date.now() - 3_600_000),
    guestLastActiveAt: new Date(),
  });
  jar.set('next-auth.session-token', await guestSession(id));
  return id;
}

const shopper = {
  sub: 'google-sub-shopper',
  email: 'new@example.com',
  email_verified: true,
  name: 'Nina',
};
const alex = {
  sub: 'google-sub-alex',
  email: 'alex@example.com',
  email_verified: true,
  name: 'Alex',
};

beforeEach(() => {
  world.users.clear();
  world.challenges.clear();
  world.profile = null;
  world.cookieHeader = '';
  world.headers = new Headers();
  seedUser('user-existing', 'alex@example.com');
});

describe('round-trip cookies are namespaced per flow (AGE-1667)', () => {
  it('an ordinary start writes only the ordinary state cookie, and an upgrade start only its own', async () => {
    const ordinary = new Map<string, string>();
    await startSignIn(ordinary, 'google');
    expect([...ordinary.keys()].filter((k) => k.includes('state') || k.includes('pkce'))).toEqual([
      ORDINARY_STATE,
      'next-auth.pkce.code_verifier',
    ]);

    const upgrade = new Map<string, string>();
    await seedGuest(upgrade);
    await startSignIn(upgrade, 'google-upgrade');
    expect(upgrade.has(UPGRADE_STATE)).toBe(true);
    expect(upgrade.has(UPGRADE_PKCE)).toBe(true);
    expect(upgrade.has(UPGRADE_CALLBACK_URL)).toBe(true);
    expect(upgrade.has(GUEST_UPGRADE_INTENT_COOKIE)).toBe(true);
    expect(upgrade.has(ORDINARY_STATE)).toBe(false);
  });
});

describe('ordinary Google sign-in (AGE-1667)', () => {
  it('signs an existing account in with the same email, and the session names that account', async () => {
    const jar: Jar = new Map();
    world.profile = alex;
    const { state } = await startSignIn(jar, 'google');

    const response = await finishSignIn(jar, 'google', state);

    expect(response.headers.get('location')).not.toContain('upgrade=');
    expect(await sessionSubjectOf(response)).toBe('user-existing');
  });
});

describe('ordinary sign-in and the upgrade overlap (AGE-1667)', () => {
  it('order 1: the ordinary start comes first, the upgrade completes, then the ordinary sign-in still completes', async () => {
    const jar: Jar = new Map();
    const guestId = await seedGuest(jar);
    world.profile = alex;
    const ordinary = await startSignIn(jar, 'google');
    const upgrade = await startSignIn(jar, 'google-upgrade');
    world.profile = shopper;

    const upgraded = await finishSignIn(jar, 'google-upgrade', upgrade.state);
    expect(upgraded.headers.get('location')).not.toContain('upgrade=');
    expect(await sessionSubjectOf(upgraded)).toBe(guestId);
    expect(world.users.get(guestId)?.isGuest).toBe(false);

    world.profile = alex;
    const signedIn = await finishSignIn(jar, 'google', ordinary.state);
    expect(signedIn.headers.get('location')).not.toContain('upgrade=');
    expect(await sessionSubjectOf(signedIn)).toBe('user-existing');
  });

  it('order 2: the upgrade starts first, the ordinary sign-in completes, and the upgrade is then refused', async () => {
    const jar: Jar = new Map();
    const guestId = await seedGuest(jar);
    const upgrade = await startSignIn(jar, 'google-upgrade');
    world.profile = alex;
    const ordinary = await startSignIn(jar, 'google');

    const signedIn = await finishSignIn(jar, 'google', ordinary.state);
    expect(signedIn.headers.get('location')).not.toContain('upgrade=');
    expect(await sessionSubjectOf(signedIn)).toBe('user-existing');

    // The browser now holds an ordinary account, not the guest: the upgrade must not promote it.
    world.profile = shopper;
    const refused = await finishSignIn(jar, 'google-upgrade', upgrade.state);
    expect(refused.headers.get('location')).toContain('/register?upgrade=expired');
    expect(await sessionSubjectOf(refused)).toBeNull();
    expect(world.users.get(guestId)?.isGuest).toBe(true);
    expect(world.users.size).toBe(2);
  });
});

describe('explicit guest upgrade through Google (AGE-1667)', () => {
  it('promotes the live guest in place and signs that same id in', async () => {
    const jar: Jar = new Map();
    const guestId = await seedGuest(jar);
    const { state } = await startSignIn(jar, 'google-upgrade');
    world.profile = shopper;

    const response = await finishSignIn(jar, 'google-upgrade', state);

    expect(response.headers.get('location')).not.toContain('upgrade=');
    expect(await sessionSubjectOf(response)).toBe(guestId);
    expect(world.users.get(guestId)).toMatchObject({ email: 'new@example.com', isGuest: false });
    expect(world.users.size).toBe(2);
    expect(jar.has(GUEST_UPGRADE_INTENT_COOKIE)).toBe(false);
    expect(jar.has(UPGRADE_STATE)).toBe(false);
  });

  it('does not start for a caller who is not a live guest: no round trip, no cookie', async () => {
    const jar: Jar = new Map();
    const response = await send(jar, 'POST', '/api/auth/signin/google-upgrade', {
      csrfToken: await csrf(jar),
      callbackUrl: '/',
      json: 'true',
    });

    expect(response.headers.get('location')).toContain('/register?upgrade=expired');
    expect(jar.has(UPGRADE_STATE)).toBe(false);
    expect(jar.has(GUEST_UPGRADE_INTENT_COOKIE)).toBe(false);
  });

  it('a canceled upgrade promotes nothing, clears its own cookies, and leaves the guest as it was', async () => {
    const jar: Jar = new Map();
    const guestId = await seedGuest(jar);
    const { state } = await startSignIn(jar, 'google-upgrade');

    const canceled = await finishSignIn(jar, 'google-upgrade', state, { error: 'access_denied' });

    expect(await sessionSubjectOf(canceled)).toBeNull();
    expect(world.users.get(guestId)?.isGuest).toBe(true);
    expect(world.users.size).toBe(2);
    expect(jar.has(GUEST_UPGRADE_INTENT_COOKIE)).toBe(false);
    expect(jar.has(UPGRADE_STATE)).toBe(false);

    // An ordinary sign-in afterwards is untouched by the canceled attempt.
    world.profile = alex;
    const ordinary = await startSignIn(jar, 'google');
    const signedIn = await finishSignIn(jar, 'google', ordinary.state);
    expect(await sessionSubjectOf(signedIn)).toBe('user-existing');
  });

  it('a newer attempt replaces an older one: the older callback is refused and the newer still promotes', async () => {
    const jar: Jar = new Map();
    const guestId = await seedGuest(jar);
    const older = await startSignIn(jar, 'google-upgrade');
    const newer = await startSignIn(jar, 'google-upgrade');
    expect(newer.state).not.toBe(older.state);
    world.profile = shopper;

    const refused = await finishSignIn(jar, 'google-upgrade', older.state);
    expect(refused.headers.get('location')).toContain('/register?upgrade=expired');
    expect(world.users.get(guestId)?.isGuest).toBe(true);
    // The refusal does not clear the newer attempt's cookies.
    expect(jar.has(UPGRADE_STATE)).toBe(true);
    expect(jar.has(GUEST_UPGRADE_INTENT_COOKIE)).toBe(true);

    const promoted = await finishSignIn(jar, 'google-upgrade', newer.state);
    expect(promoted.headers.get('location')).not.toContain('upgrade=');
    expect(world.users.get(guestId)?.isGuest).toBe(false);
    expect(world.users.size).toBe(2);
  });

  it('a guest that expired before the callback yields no account and no session', async () => {
    const jar: Jar = new Map();
    const guestId = await seedGuest(jar);
    const { state } = await startSignIn(jar, 'google-upgrade');
    world.users.delete(guestId);
    world.profile = shopper;

    const response = await finishSignIn(jar, 'google-upgrade', state);

    expect(response.headers.get('location')).toContain('/register?upgrade=expired');
    expect(await sessionSubjectOf(response)).toBeNull();
    expect(world.users.size).toBe(1);
  });

  it('a replayed callback promotes nothing, with the browser cookies or with an older copy of them', async () => {
    const jar: Jar = new Map();
    const guestId = await seedGuest(jar);
    const { state } = await startSignIn(jar, 'google-upgrade');
    const beforeCallback: Jar = new Map(jar);
    world.profile = shopper;
    const first = await finishSignIn(jar, 'google-upgrade', state);
    expect(first.headers.get('location')).not.toContain('upgrade=');

    // The browser's cookies were cleared by the first callback: nothing left to validate against.
    const cleared = await finishSignIn(jar, 'google-upgrade', state);
    expect(cleared.headers.get('location')).toContain('/register?upgrade=expired');

    // An older copy of the cookies (a replay) passes NextAuth's checks, but the row is already an account.
    const replayed = await finishSignIn(beforeCallback, 'google-upgrade', state);
    expect(replayed.headers.get('location')).toContain('/register?upgrade=expired');
    expect(await sessionSubjectOf(replayed)).toBeNull();
    expect(world.users.get(guestId)).toMatchObject({ email: 'new@example.com', isGuest: false });
    expect(world.users.size).toBe(2);
  });
});
