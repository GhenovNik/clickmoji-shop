// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GUEST_UPGRADE_INTENT_COOKIE as UPGRADE_INTENT_COOKIE,
  GUEST_UPGRADE_PROVIDER_ID,
} from './guest-upgrade-intent';

/**
 * Real-PostgreSQL checks of guest upgrades (AGE-1667): Google sign-in and email registration of the
 * same guest, collisions with an existing account, races between the two providers, verification
 * side effects, and the GUEST_REGISTERED milestone with or without the analytics cookie.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a disposable local database, e.g.:
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:…@127.0.0.1:<port>/clickmoji_integration \
 *     npx vitest run src/lib/guest-upgrade.integration
 * The URL is refused unless it names localhost, so no shared or production database can be used.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const isLocal = url ? ['localhost', '127.0.0.1'].includes(new URL(url).hostname) : false;
const SECRET = `integration-${randomUUID()}`;

if (url && isLocal) {
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET = SECRET;
  delete process.env.NEXTAUTH_SECRET;
}

const jar = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
const mail = vi.hoisted(() => ({
  verificationRequired: false,
  sent: 0,
  error: null as null | Error,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => ({ get: () => null }),
}));
vi.mock('@/lib/email', () => ({
  isEmailVerificationRequired: () => mail.verificationRequired,
  sendVerificationEmail: async () => {
    if (mail.error) throw mail.error;
    mail.sent += 1;
  },
}));
vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 99, resetAt: 0 }) };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'next-auth.session-token';
const FUNNEL_COOKIE = 'clickmoji_funnel_guest';

type SignInArgs = {
  user: { id: string; email?: string | null; name?: string | null; image?: string | null };
  account: { provider: string; type: string; providerAccountId: string } | null;
  profile?: Record<string, unknown>;
};

describe.skipIf(!url || !isLocal)('guest upgrade on PostgreSQL', () => {
  const tag = `upg-${randomUUID()}`;
  const createdIds: string[] = [];
  const emails: string[] = [];
  let prisma: import('@prisma/client').PrismaClient;
  let POST: (request: Request) => Promise<Response>;
  let encode: typeof import('next-auth/jwt').encode;
  let authOptions: typeof import('./auth').authOptions;
  let signInCallback: (args: SignInArgs) => Promise<boolean>;
  let jwtCallback: (args: {
    token: Record<string, unknown>;
    user?: unknown;
    account?: unknown;
  }) => Promise<Record<string, unknown>>;
  let signGuestId: typeof import('./funnel').signGuestId;
  let mintGuestUpgradeIntent: typeof import('./guest-promotion').mintGuestUpgradeIntent;

  function uniqueEmail(label: string) {
    const address = `${label}-${randomUUID().slice(0, 8)}-${tag}@example.test`;
    emails.push(address);
    return address;
  }

  async function insertGuest(label: string, lastActive: Date = new Date()) {
    const row = await prisma.user.create({
      data: {
        email: `guest_${randomUUID()}@guest.clickmoji.invalid`,
        isGuest: true,
        role: 'USER',
        createdAt: lastActive,
        guestLastActiveAt: lastActive,
        name: label,
      },
      select: { id: true, createdAt: true },
    });
    createdIds.push(row.id);
    await prisma.list.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({
        name: `${label}-${index}`,
        userId: row.id,
        isActive: index === 0,
      })),
    });
    return row;
  }

  async function sessionToken(userId: string, issuedAt: number) {
    return encode({
      token: {
        id: userId,
        sub: userId,
        role: 'USER',
        email: 'guest',
        isGuest: true,
        sessionIssuedAt: issuedAt,
      },
      secret: SECRET,
      maxAge: 60,
    });
  }

  /** Puts a guest session (and optionally the analytics cookie) into the browser's cookie jar. */
  async function holdGuest(userId: string, createdAt: Date, funnelGuest?: string) {
    jar.cookies.clear();
    jar.cookies.set(
      SESSION_COOKIE,
      await sessionToken(userId, Math.floor(createdAt.getTime() / 1000))
    );
    if (funnelGuest) {
      jar.cookies.set(FUNNEL_COOKIE, signGuestId(funnelGuest) ?? '');
    }
  }

  function register(email: string) {
    return POST(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: [
            'NEXT_LOCALE=en',
            ...[...jar.cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`),
          ].join('; '),
        },
        body: JSON.stringify({ email, password: 'password1', name: 'Racer' }),
      })
    );
  }

  /**
   * Arms an explicit upgrade for one guest, as POST /api/auth/guest-upgrade does (AGE-1667): the
   * signed intent cookie names the guest's User.id. The Google round trip is then the
   * `google-upgrade` provider, as the register page starts it.
   */
  async function setUpgradeIntent(guestUserId: string) {
    jar.cookies.set(UPGRADE_INTENT_COOKIE, await mintGuestUpgradeIntent(guestUserId));
  }

  function googleSignIn(
    email: string,
    options: { verified?: boolean; sub?: string; explicit?: string } = {}
  ) {
    const sub = options.sub ?? `google-${randomUUID()}`;
    if (options.explicit) setUpgradeIntent(options.explicit);
    return signInCallback({
      user: { id: sub, email, name: 'Google Name', image: 'https://img.example.test/a.png' },
      account: {
        provider: options.explicit ? GUEST_UPGRADE_PROVIDER_ID : 'google',
        type: 'oauth',
        providerAccountId: sub,
      },
      profile: { sub, email, email_verified: options.verified ?? true, name: 'Google Name' },
    });
  }

  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    const { createPrismaPgAdapter } = await import('./prisma-adapter');
    prisma = new PrismaClient({ adapter: createPrismaPgAdapter(url!) });
    ({ POST } = await import('@/app/api/auth/register/route'));
    ({ encode } = await import('next-auth/jwt'));
    ({ authOptions } = await import('./auth'));
    signInCallback = authOptions.callbacks!.signIn as unknown as typeof signInCallback;
    jwtCallback = authOptions.callbacks!.jwt as unknown as typeof jwtCallback;
    ({ signGuestId } = await import('./funnel'));
    ({ mintGuestUpgradeIntent } = await import('./guest-promotion'));
  });

  beforeEach(() => {
    jar.cookies.clear();
    mail.verificationRequired = false;
    mail.sent = 0;
    mail.error = null;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.funnelEvent.deleteMany({ where: { userId: { in: createdIds } } });
      await prisma.emailVerificationToken.deleteMany({ where: { email: { in: emails } } });
      await prisma.user.deleteMany({
        where: { OR: [{ id: { in: createdIds } }, { email: { in: emails } }] },
      });
      await prisma.$disconnect();
    }
  });

  describe('Google sign-in from a guest session', () => {
    it('promotes the guest in place: same User.id, lists kept, no second account', async () => {
      const guest = await insertGuest('g-google');
      const email = uniqueEmail('google-promote');
      await holdGuest(guest.id, guest.createdAt, `funnel-${tag}-g1`);

      const allowed = await googleSignIn(email, { explicit: guest.id });
      expect(allowed).toBe(true);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: guest.id },
        select: { isGuest: true, email: true, emailVerified: true, password: true, name: true },
      });
      expect(row).toMatchObject({ isGuest: false, email, password: null, name: 'Google Name' });
      expect(row.emailVerified).toBeInstanceOf(Date);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(await prisma.list.count({ where: { userId: guest.id } })).toBe(5);
    });

    it('the signIn callback hands NextAuth the guest id, and the new token is an ordinary session', async () => {
      const guest = await insertGuest('g-token');
      const email = uniqueEmail('google-token');
      await holdGuest(guest.id, guest.createdAt);
      const user = { id: 'google-sub-raw', email, name: 'G', image: null } as SignInArgs['user'];
      await setUpgradeIntent(guest.id);
      const account = {
        provider: GUEST_UPGRADE_PROVIDER_ID,
        type: 'oauth',
        providerAccountId: 'raw',
      };

      const allowed = await signInCallback({
        user,
        account,
        profile: { email, email_verified: true },
      });
      expect(allowed).toBe(true);
      expect(user.id).toBe(guest.id);

      const token = await jwtCallback({
        token: {},
        user,
        account,
      });
      expect(token).toMatchObject({ id: guest.id, sub: guest.id, isGuest: false });
    });

    it('the pre-upgrade guest token is rejected once the row is an account', async () => {
      const guest = await insertGuest('g-old-token');
      const email = uniqueEmail('google-old');
      await holdGuest(guest.id, guest.createdAt);
      const oldToken = {
        id: guest.id,
        sub: guest.id,
        role: 'USER',
        email: 'guest',
        isGuest: true,
        sessionIssuedAt: Math.floor(guest.createdAt.getTime() / 1000),
      };
      expect(await googleSignIn(email, { explicit: guest.id })).toBe(true);

      await expect(jwtCallback({ token: oldToken })).rejects.toThrow(
        'Guest session superseded by account'
      );
    });

    it('refuses an unverified Google address and leaves the guest untouched', async () => {
      const guest = await insertGuest('g-unverified');
      const email = uniqueEmail('google-unverified');
      await holdGuest(guest.id, guest.createdAt);

      expect(await googleSignIn(email, { verified: false, explicit: guest.id })).toBe(
        '/register?upgrade=unverified'
      );

      expect(await prisma.user.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
        isGuest: true,
      });
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });

    it('an explicit upgrade to an email an account already holds is refused: no switch, no merge', async () => {
      const guest = await insertGuest('g-collide');
      const existing = await prisma.user.create({
        data: { email: uniqueEmail('google-existing'), password: 'hashed:x', name: 'Owner' },
        select: { id: true, email: true },
      });
      createdIds.push(existing.id);
      await holdGuest(guest.id, guest.createdAt);
      await setUpgradeIntent(guest.id);

      const user = {
        id: 'g-sub-collide',
        email: existing.email,
        name: 'G',
        image: null,
      } as SignInArgs['user'];
      expect(
        await signInCallback({
          user,
          account: {
            provider: GUEST_UPGRADE_PROVIDER_ID,
            type: 'oauth',
            providerAccountId: 'collide',
          },
          profile: { email: existing.email, email_verified: true },
        })
      ).toBe('/register?upgrade=email-taken');

      expect(user.id).toBe('g-sub-collide');
      expect(await prisma.user.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
        isGuest: true,
      });
      expect(await prisma.list.count({ where: { userId: guest.id } })).toBe(5);
      expect(await prisma.user.count({ where: { email: existing.email } })).toBe(1);
    });

    it('ordinary Google sign-in to an email an account holds signs into that account and leaves the guest alone', async () => {
      const guest = await insertGuest('g-collide-plain');
      const existing = await prisma.user.create({
        data: { email: uniqueEmail('google-plain'), password: 'hashed:x', name: 'Owner' },
        select: { id: true, email: true },
      });
      createdIds.push(existing.id);
      await holdGuest(guest.id, guest.createdAt);

      const user = {
        id: 'g-sub-plain',
        email: existing.email,
        name: 'G',
        image: null,
      } as SignInArgs['user'];
      expect(
        await signInCallback({
          user,
          account: { provider: 'google', type: 'oauth', providerAccountId: 'plain' },
          profile: { email: existing.email, email_verified: true },
        })
      ).toBe(true);

      expect(user.id).toBe(existing.id);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
        isGuest: true,
      });
      expect(await prisma.list.count({ where: { userId: guest.id } })).toBe(5);
    });

    it('ordinary Google sign-in with a live guest cookie never promotes the guest, even with an armed intent', async () => {
      const guest = await insertGuest('g-ordinary');
      const email = uniqueEmail('google-ordinary');
      await holdGuest(guest.id, guest.createdAt);
      await setUpgradeIntent(guest.id);

      expect(await googleSignIn(email)).toBe(true);

      expect(await prisma.user.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
        isGuest: true,
      });
      const created = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      createdIds.push(created.id);
      expect(created.id).not.toBe(guest.id);
    });

    it('a guest cookie whose row cleanup removed is no guest: a plain Google sign-in creates its account', async () => {
      const gone = await insertGuest('g-gone');
      await prisma.user.delete({ where: { id: gone.id } });
      const email = uniqueEmail('google-gone');
      await holdGuest(gone.id, gone.createdAt);

      expect(await googleSignIn(email, { explicit: gone.id })).toBe('/register?upgrade=expired');
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });

    it('a guest cookie whose row cleanup removed is no guest for ordinary Google sign-in: a plain account is created', async () => {
      const gone = await insertGuest('g-gone-plain');
      await prisma.user.delete({ where: { id: gone.id } });
      const email = uniqueEmail('google-gone-plain');
      await holdGuest(gone.id, gone.createdAt);

      expect(await googleSignIn(email)).toBe(true);
      const created = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      createdIds.push(created.id);
      expect(created.id).not.toBe(gone.id);
    });

    it('writes one GUEST_REGISTERED for the promotion, also without the analytics cookie', async () => {
      const guest = await insertGuest('g-funnel-none');
      const email = uniqueEmail('google-funnel');
      await holdGuest(guest.id, guest.createdAt);

      expect(await googleSignIn(email, { explicit: guest.id })).toBe(true);

      const events = await prisma.funnelEvent.findMany({
        where: { userId: guest.id, type: 'GUEST_REGISTERED' },
        select: { guestId: true },
      });
      expect(events).toEqual([{ guestId: null }]);
      expect(
        await prisma.funnelEvent.count({ where: { userId: guest.id, type: 'REGISTER' } })
      ).toBe(0);
    });
  });

  describe('races between email registration and Google for one guest', () => {
    // These call the promotion functions directly: the cookie jar is process-wide, so concurrent
    // signIn callbacks could not each see their own guest. The database still interleaves the writes.
    let promoteGuestAccount: typeof import('./guest-promotion').promoteGuestAccount;
    let promoteGuestWithGoogleIdentity: typeof import('./guest-promotion').promoteGuestWithGoogleIdentity;

    beforeAll(async () => {
      ({ promoteGuestAccount, promoteGuestWithGoogleIdentity } = await import('./guest-promotion'));
    });

    it('email and Google promotions of one guest at once: exactly one promotion commits', async () => {
      const guest = await insertGuest('race-mixed');
      const email = uniqueEmail('race-mixed');

      const [byEmail, byGoogle] = await Promise.all([
        promoteGuestAccount({
          userId: guest.id,
          guestId: `funnel-${tag}-race`,
          email,
          passwordHash: 'hashed:password1',
          name: 'Racer',
          emailVerified: null,
        }),
        promoteGuestWithGoogleIdentity({
          userId: guest.id,
          guestId: `funnel-${tag}-race`,
          email,
          name: 'Racer',
          image: null,
        }),
      ]);

      const outcomes = [byEmail.status, byGoogle.status].sort();
      expect(outcomes.filter((status) => status === 'promoted')).toHaveLength(1);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
        isGuest: false,
        email,
      });
      expect(
        await prisma.funnelEvent.count({ where: { userId: guest.id, type: 'GUEST_REGISTERED' } })
      ).toBe(1);
    });

    it('two guests race for one Google address: one promotes, the other is refused and stays a guest', async () => {
      const first = await insertGuest('gg-first');
      const second = await insertGuest('gg-second');
      const email = uniqueEmail('gg-race');

      const [a, b] = await Promise.all([
        promoteGuestWithGoogleIdentity({
          userId: first.id,
          guestId: `funnel-${tag}-gg1`,
          email,
          name: null,
          image: null,
        }),
        promoteGuestWithGoogleIdentity({
          userId: second.id,
          guestId: `funnel-${tag}-gg2`,
          email,
          name: null,
          image: null,
        }),
      ]);

      expect([a.status, b.status].sort()).toEqual(['email-taken', 'promoted']);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      const loser = a.status === 'promoted' ? second.id : first.id;
      expect(await prisma.user.findUniqueOrThrow({ where: { id: loser } })).toMatchObject({
        isGuest: true,
      });
    });

    it('two Google promotions of one guest at once: exactly one promotion commits', async () => {
      const guest = await insertGuest('gg-same');
      const email = uniqueEmail('gg-same');

      const results = await Promise.all([
        promoteGuestWithGoogleIdentity({
          userId: guest.id,
          guestId: null,
          email,
          name: null,
          image: null,
        }),
        promoteGuestWithGoogleIdentity({
          userId: guest.id,
          guestId: null,
          email,
          name: null,
          image: null,
        }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        'already-registered',
        'promoted',
      ]);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(
        await prisma.funnelEvent.count({ where: { userId: guest.id, type: 'GUEST_REGISTERED' } })
      ).toBe(1);
    });
  });

  describe('email registration with verification and a guest session', () => {
    it('a verification email failure rolls the promotion back: guest unchanged, no token kept', async () => {
      const guest = await insertGuest('v-fail');
      const email = uniqueEmail('v-fail');
      mail.verificationRequired = true;
      mail.error = new Error('SMTP unavailable');
      await holdGuest(guest.id, guest.createdAt, `funnel-${tag}-vf`);

      const response = await register(email);

      expect(response.status).toBe(503);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
        isGuest: true,
        password: null,
        email: expect.stringContaining('@guest.clickmoji.invalid'),
      });
      expect(await prisma.emailVerificationToken.count({ where: { email } })).toBe(0);
      expect(
        await prisma.funnelEvent.count({ where: { userId: guest.id, type: 'GUEST_REGISTERED' } })
      ).toBe(0);
      expect(await prisma.list.count({ where: { userId: guest.id } })).toBe(5);
    });

    it('a successful promotion with verification stores exactly one usable token and issues no session', async () => {
      const guest = await insertGuest('v-ok');
      const email = uniqueEmail('v-ok');
      mail.verificationRequired = true;
      await holdGuest(guest.id, guest.createdAt);

      const response = await register(email);

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        requiresEmailVerification: true,
        promoted: true,
      });
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).not.toMatch(/next-auth\.session-token=[^;]+;/);
      expect(setCookie).toMatch(/next-auth\.session-token=;.*Max-Age=0/);
      expect(mail.sent).toBe(1);
      expect(await prisma.emailVerificationToken.count({ where: { email } })).toBe(1);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
        isGuest: false,
        emailVerified: null,
      });
    });

    it('a promotion that loses the email race sends no mail and leaves no token', async () => {
      const guest = await insertGuest('v-race');
      const owner = await prisma.user.create({
        data: { email: uniqueEmail('v-race-owner'), password: 'hashed:x', name: 'Owner' },
        select: { id: true, email: true },
      });
      createdIds.push(owner.id);
      mail.verificationRequired = true;
      await holdGuest(guest.id, guest.createdAt);

      const response = await register(owner.email);

      expect(response.status).toBe(400);
      expect(mail.sent).toBe(0);
      expect(await prisma.emailVerificationToken.count({ where: { email: owner.email } })).toBe(0);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
        isGuest: true,
      });
    });

    it('without verification the ordinary session replaces the guest cookie at once', async () => {
      const guest = await insertGuest('v-off');
      const email = uniqueEmail('v-off');
      mail.verificationRequired = false;
      await holdGuest(guest.id, guest.createdAt);

      const response = await register(email);

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        requiresEmailVerification: false,
        promoted: true,
      });
      expect(response.headers.get('set-cookie')).toMatch(/next-auth\.session-token=[^;]+;/);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
        isGuest: false,
      });
    });
  });

  describe('stale guest registration', () => {
    it('a signed guest whose row cleanup removed creates no account and clears the cookie', async () => {
      const gone = await insertGuest('stale-gone');
      await prisma.user.delete({ where: { id: gone.id } });
      const email = uniqueEmail('stale-gone');
      await holdGuest(gone.id, gone.createdAt);

      const response = await register(email);

      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toMatch(/next-auth\.session-token=;.*Max-Age=0/);
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });
  });
});
