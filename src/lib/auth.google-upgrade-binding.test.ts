// @vitest-environment node
//
// The NextAuth layer that binds an OAuth round trip to its provider (AGE-1667). These run the real
// state and PKCE checks of the installed next-auth, with its real signed cookies, to prove that the
// `google-upgrade` callback and the ordinary `google` callback cannot consume each other's cookies.
import path from 'node:path';
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const nextAuthRoot = path.dirname(require.resolve('next-auth'));

type Checks = {
  state: {
    create: (o: unknown, cookies: unknown[], params: Record<string, string>) => Promise<void>;
    use: (
      c: Record<string, string>,
      res: unknown[],
      o: unknown,
      checks: Record<string, string>
    ) => Promise<void>;
  };
  pkce: {
    create: (o: unknown, cookies: unknown[], params: Record<string, string>) => Promise<void>;
    use: (
      c: Record<string, string>,
      res: unknown[],
      o: unknown,
      checks: Record<string, string>
    ) => Promise<void>;
  };
};

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

function optionsFor(providerId: string) {
  return {
    provider: { id: providerId, checks: ['pkce', 'state'] },
    cookies: defaultCookies(false),
    jwt: { secret: 'test-secret-for-oauth-binding' },
    logger,
  };
}

/** One browser's cookie jar, keyed by name exactly as the browser keys it. */
type Jar = Record<string, string>;

function setCookies(jar: Jar, cookies: { name: string; value: string }[]) {
  for (const cookie of cookies) jar[cookie.name] = cookie.value;
}

/** What the start of an OAuth round trip for one provider sets: its state and PKCE cookies. */
async function start(jar: Jar, providerId: string) {
  const options = optionsFor(providerId);
  const params: Record<string, string> = {};
  const cookies: { name: string; value: string }[] = [];
  await checks.state.create(options, cookies, params);
  await checks.pkce.create(options, cookies, params);
  setCookies(jar, cookies);
  return { state: params.state };
}

/**
 * The callback of one provider: NextAuth's own state and PKCE checks against the jar. The cookies
 * the callback clears (value '') are applied to the jar, as the browser would apply them.
 */
async function finish(jar: Jar, providerId: string) {
  const options = optionsFor(providerId);
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

describe('OAuth round trips are bound to their provider (AGE-1667)', () => {
  let jar: Jar;

  beforeEach(() => {
    jar = {};
  });

  it('an upgrade round trip completes its own callback', async () => {
    const started = await start(jar, 'google-upgrade');
    const done = await finish(jar, 'google-upgrade');
    expect(done.state).toBe(started.state);
  });

  it('an ordinary round trip completes its own callback', async () => {
    const started = await start(jar, 'google');
    const done = await finish(jar, 'google');
    expect(done.state).toBe(started.state);
  });

  it('the ordinary callback refuses a state cookie started as an upgrade', async () => {
    await start(jar, 'google-upgrade');
    await expect(finish(jar, 'google')).rejects.toThrow(/different provider/);
  });

  it('the upgrade callback refuses a state cookie started as an ordinary sign-in', async () => {
    await start(jar, 'google');
    await expect(finish(jar, 'google-upgrade')).rejects.toThrow(/different provider/);
  });

  it('a concurrent ordinary start overwrites the upgrade cookie, so the upgrade fails closed', async () => {
    await start(jar, 'google-upgrade');
    await start(jar, 'google');
    await expect(finish(jar, 'google-upgrade')).rejects.toThrow(/different provider/);
  });

  it('a concurrent upgrade start overwrites the ordinary cookie, so the ordinary callback fails closed', async () => {
    await start(jar, 'google');
    await start(jar, 'google-upgrade');
    await expect(finish(jar, 'google')).rejects.toThrow(/different provider/);
  });

  it('a canceled upgrade leaves nothing that an ordinary round trip can consume', async () => {
    await start(jar, 'google-upgrade');
    // The user cancels at Google; no callback ever runs for it.
    const later = await start(jar, 'google');
    const done = await finish(jar, 'google');
    expect(done.state).toBe(later.state);
  });

  it('a replayed upgrade callback finds its state cookie already consumed', async () => {
    await start(jar, 'google-upgrade');
    await finish(jar, 'google-upgrade');
    await expect(finish(jar, 'google-upgrade')).rejects.toThrow(/cookie was missing/);
  });
});
