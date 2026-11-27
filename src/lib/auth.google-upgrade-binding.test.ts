// @vitest-environment node
//
// The NextAuth round-trip checks (state and PKCE) with the exact cookie sets the app uses (AGE-1667).
// Both flows use the one `google` provider id, so the separation is by cookie: the ordinary sign-in
// keeps NextAuth's default names, and the explicit upgrade has its own namespace
// (guest-upgrade-oauth.ts). The full route-level behaviour is in auth.google-upgrade-flow.test.ts.
// Here the installed checks run on real signed cookies, so overlapping round trips are proven at the
// cookie level, in both orders.
import path from 'node:path';
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { guestUpgradeOAuthCookies } from './guest-upgrade-oauth';

const require = createRequire(import.meta.url);
const nextAuthRoot = path.dirname(require.resolve('next-auth'));

type Check = {
  create: (o: unknown, cookies: unknown[], params: Record<string, string>) => Promise<void>;
  use: (
    c: Record<string, string>,
    res: unknown[],
    o: unknown,
    checks: Record<string, string>
  ) => Promise<void>;
};
type Checks = { state: Check; pkce: Check };

let checks: Checks;
let defaultCookies: (secure: boolean) => Record<string, { name: string; options: object }>;

beforeAll(() => {
  checks = require(path.join(nextAuthRoot, 'core/lib/oauth/checks.js')) as Checks;
  defaultCookies = (
    require(path.join(nextAuthRoot, 'core/lib/cookie.js')) as {
      defaultCookies: typeof defaultCookies;
    }
  ).defaultCookies;
});

const logger = { debug: () => undefined, error: () => undefined, warn: () => undefined };

/** The cookie set of each flow, exactly as the route configures it (secure = false, as in local dev). */
const ORDINARY_COOKIES = () => defaultCookies(false);
const UPGRADE_COOKIES = () =>
  guestUpgradeOAuthCookies(false) as Record<string, { name: string; options: object }>;

function optionsFor(
  providerId: string,
  cookies: Record<string, { name: string; options: object }>
) {
  return {
    provider: { id: providerId, checks: ['pkce', 'state'] },
    cookies,
    jwt: { secret: 'test-secret-for-oauth-binding' },
    logger,
  };
}

/** One browser's cookie jar, keyed by name exactly as the browser keys it. */
type Jar = Record<string, string>;

function setCookies(jar: Jar, cookies: { name: string; value: string }[]) {
  for (const cookie of cookies) jar[cookie.name] = cookie.value;
}

/** The start of one round trip: its state and PKCE cookies, written into the jar. */
async function start(
  jar: Jar,
  providerId: string,
  cookies: Record<string, { name: string; options: object }>
) {
  const options = optionsFor(providerId, cookies);
  const params: Record<string, string> = {};
  const written: { name: string; value: string }[] = [];
  await checks.state.create(options, written, params);
  await checks.pkce.create(options, written, params);
  setCookies(jar, written);
  return { state: params.state };
}

/** The callback of one round trip: NextAuth's own checks against the jar, then the cleared cookies. */
async function finish(
  jar: Jar,
  providerId: string,
  cookies: Record<string, { name: string; options: object }>
) {
  const options = optionsFor(providerId, cookies);
  const checksOut: Record<string, string> = {};
  const cleared: { name: string; value: string }[] = [];
  await checks.state.use(jar, cleared, options, checksOut);
  await checks.pkce.use(jar, cleared, options, checksOut);
  for (const cookie of cleared) {
    if (cookie.value === '') delete jar[cookie.name];
    else jar[cookie.name] = cookie.value;
  }
  return checksOut;
}

describe('OAuth round trips with the app cookie sets (AGE-1667)', () => {
  let jar: Jar;

  beforeEach(() => {
    jar = {};
  });

  it('the upgrade keeps its round-trip cookies out of the ordinary names', () => {
    const upgrade = UPGRADE_COOKIES();
    expect(upgrade.state.name).toBe('next-auth.guest-upgrade.state');
    expect(upgrade.pkceCodeVerifier.name).toBe('next-auth.guest-upgrade.pkce.code_verifier');
    expect(upgrade.callbackUrl.name).toBe('next-auth.guest-upgrade.callback-url');
    expect(upgrade.state.name).not.toBe(ORDINARY_COOKIES().state.name);
    expect(upgrade.pkceCodeVerifier.name).not.toBe(ORDINARY_COOKIES().pkceCodeVerifier.name);
    expect(upgrade.callbackUrl.name).not.toBe(ORDINARY_COOKIES().callbackUrl.name);
  });

  it('shares the session and CSRF cookies with the ordinary flow: one browser, one session', () => {
    const upgrade = UPGRADE_COOKIES();
    const ordinary = ORDINARY_COOKIES();
    expect(upgrade.sessionToken.name).toBe(ordinary.sessionToken.name);
    expect(upgrade.csrfToken.name).toBe(ordinary.csrfToken.name);
  });

  it('an ordinary round trip completes its own callback', async () => {
    const started = await start(jar, 'google', ORDINARY_COOKIES());
    const done = await finish(jar, 'google', ORDINARY_COOKIES());
    expect(done.state).toBe(started.state);
  });

  it('an upgrade round trip completes its own callback', async () => {
    const started = await start(jar, 'google', UPGRADE_COOKIES());
    const done = await finish(jar, 'google', UPGRADE_COOKIES());
    expect(done.state).toBe(started.state);
  });

  it('order 1: an upgrade started, then an ordinary start: both callbacks complete', async () => {
    const upgrade = await start(jar, 'google', UPGRADE_COOKIES());
    const ordinary = await start(jar, 'google', ORDINARY_COOKIES());

    expect((await finish(jar, 'google', ORDINARY_COOKIES())).state).toBe(ordinary.state);
    expect((await finish(jar, 'google', UPGRADE_COOKIES())).state).toBe(upgrade.state);
  });

  it('order 2: an ordinary start, then an upgrade started: both callbacks complete', async () => {
    const ordinary = await start(jar, 'google', ORDINARY_COOKIES());
    const upgrade = await start(jar, 'google', UPGRADE_COOKIES());

    expect((await finish(jar, 'google', UPGRADE_COOKIES())).state).toBe(upgrade.state);
    expect((await finish(jar, 'google', ORDINARY_COOKIES())).state).toBe(ordinary.state);
  });

  it('a canceled upgrade (no callback) leaves nothing an ordinary round trip can consume', async () => {
    await start(jar, 'google', UPGRADE_COOKIES());
    // The user cancels at Google; the upgrade callback never runs. An ordinary sign-in follows.
    const later = await start(jar, 'google', ORDINARY_COOKIES());
    expect((await finish(jar, 'google', ORDINARY_COOKIES())).state).toBe(later.state);
  });

  it('a replayed upgrade callback finds its state cookie already consumed', async () => {
    await start(jar, 'google', UPGRADE_COOKIES());
    await finish(jar, 'google', UPGRADE_COOKIES());
    await expect(finish(jar, 'google', UPGRADE_COOKIES())).rejects.toThrow(/cookie was missing/);
  });

  it('an ordinary callback refuses an upgrade state cookie that is copied under the ordinary name', async () => {
    await start(jar, 'google', UPGRADE_COOKIES());
    // The signature is salted with the cookie's own name, so the copy does not verify as ordinary state.
    jar[ORDINARY_COOKIES().state.name] = jar[UPGRADE_COOKIES().state.name];
    await expect(finish(jar, 'google', ORDINARY_COOKIES())).rejects.toThrow(
      /decryption operation failed|could not be parsed|different provider/
    );
  });
});
