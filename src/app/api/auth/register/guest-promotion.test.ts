// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decode, encode } from 'next-auth/jwt';

/**
 * Registration with a guest session promotes that guest in place (AGE-1667). These tests run the
 * real route against an in-memory User table. The table applies the same conditional writes the
 * database would (`where { id, isGuest: true }`, unique email), so the races are real interleavings
 * of the route's awaits, not timing luck.
 */

type Row = {
  id: string;
  email: string;
  password: string | null;
  name: string | null;
  image: string | null;
  role: string;
  isGuest: boolean;
  emailVerified: Date | null;
  guestLastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const db = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  funnel: [] as Array<Record<string, unknown>>,
  deletedUserIds: [] as string[],
  listCreates: 0,
  userCreates: 0,
  emailGate: null as null | Promise<void>,
  emailError: null as null | Error,
  verificationRequired: false,
  mailSent: 0,
  seq: 0,
}));

type AnyRecord = Record<string, unknown>;

function matches(row: AnyRecord, where: AnyRecord): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as AnyRecord[]).some((branch) => matches(row, branch));
    }
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const cond = condition as AnyRecord;
      if ('lt' in cond) {
        const value = row[key];
        return value instanceof Date && value.getTime() < (cond.lt as Date).getTime();
      }
    }
    if (condition === null) {
      return row[key] === null || row[key] === undefined;
    }
    return row[key] === condition;
  });
}

function uniqueEmailError() {
  return Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), {
    code: 'P2002',
  });
}

const fakePrisma = vi.hoisted(() => {
  const pick = (row: AnyRecord, select?: AnyRecord) => {
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null]));
  };
  const user = {
    findUnique: async ({ where, select }: { where: AnyRecord; select?: AnyRecord }) => {
      const row = db.users.find((candidate) => matches(candidate, where));
      return row ? pick(row, select) : null;
    },
    findUniqueOrThrow: async ({ where, select }: { where: AnyRecord; select?: AnyRecord }) => {
      const row = db.users.find((candidate) => matches(candidate, where));
      if (!row) throw new Error('not found');
      return pick(row, select);
    },
    create: async ({ data }: { data: AnyRecord }) => {
      db.userCreates += 1;
      if (db.users.some((row) => row.email === data.email)) throw uniqueEmailError();
      const now = new Date();
      db.seq += 1;
      const row = {
        id: `new-user-${db.seq}`,
        image: null,
        role: 'USER',
        isGuest: false,
        guestLastActiveAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      db.users.push(row);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: AnyRecord; data: AnyRecord }) => {
      const targets = db.users.filter((row) => matches(row, where));
      if (targets.some((row) => data.email !== undefined && row.email !== data.email)) {
        const clash = db.users.some((row) => row.email === data.email && !targets.includes(row));
        if (clash) throw uniqueEmailError();
      }
      for (const row of targets) Object.assign(row, data, { updatedAt: new Date() });
      return { count: targets.length };
    },
    delete: async ({ where }: { where: AnyRecord }) => {
      const index = db.users.findIndex((row) => matches(row, where));
      if (index < 0) throw new Error('not found');
      db.deletedUserIds.push(String(where.id));
      const [removed] = db.users.splice(index, 1);
      return removed;
    },
    deleteMany: async ({ where }: { where: AnyRecord }) => {
      const doomed = db.users.filter((row) => matches(row, where));
      for (const row of doomed) db.deletedUserIds.push(row.id as string);
      db.users = db.users.filter((row) => !doomed.includes(row));
      return { count: doomed.length };
    },
  };
  /**
   * A transaction keeps an undo log of its own writes. A failed transaction reverts exactly the rows
   * it touched, so a concurrent transaction that committed in between is not clobbered.
   */
  const transactional = async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
    const undo: Array<() => void> = [];
    const tx = {
      ...fakePrisma,
      user: {
        ...user,
        updateMany: async (args: { where: AnyRecord; data: AnyRecord }) => {
          for (const row of db.users.filter((candidate) => matches(candidate, args.where))) {
            const before = { ...row };
            undo.push(() => Object.assign(row, before));
          }
          return user.updateMany(args);
        },
        create: async (args: { data: AnyRecord }) => {
          const row = await user.create(args);
          undo.push(() => {
            db.users = db.users.filter((candidate) => candidate.id !== row.id);
          });
          return row;
        },
      },
      funnelEvent: {
        ...fakePrisma.funnelEvent,
        create: async (args: { data: AnyRecord }) => {
          const event = await fakePrisma.funnelEvent.create(args);
          undo.push(() => {
            db.funnel = db.funnel.filter((candidate) => candidate !== event);
          });
          return event;
        },
      },
    };
    try {
      return await run(tx);
    } catch (error) {
      for (const revert of undo.reverse()) revert();
      throw error;
    }
  };

  return {
    user,
    list: {
      createMany: async () => {
        db.listCreates += 1;
        return { count: 5 };
      },
    },
    funnelEvent: {
      create: async ({ data }: { data: AnyRecord }) => {
        db.funnel.push({ ...data });
        return data;
      },
      findFirst: async ({ where }: { where: AnyRecord }) =>
        db.funnel.find((event) => matches(event, where)) ?? null,
      updateMany: async () => ({ count: 0 }),
    },
    emailVerificationToken: { deleteMany: async () => ({ count: 0 }) },
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ now: new Date() }],
    $transaction: transactional,
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: fakePrisma }));
vi.mock('bcryptjs', () => ({ default: { hash: async (value: string) => `hashed:${value}` } }));
vi.mock('@/lib/email', () => ({
  isEmailVerificationRequired: () => db.verificationRequired,
  sendVerificationEmail: async () => {
    if (db.emailGate) await db.emailGate;
    if (db.emailError) throw db.emailError;
    db.mailSent += 1;
  },
}));
vi.mock('@/lib/auth-tokens', () => ({ createEmailVerificationToken: async () => 'verify-token' }));
vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 9, resetAt: 0 }) };
});

const { POST } = await import('./route');
const { inactiveGuestWhere } = await import('@/lib/guest-cleanup');
const { signGuestId, FUNNEL_GUEST_COOKIE } = await import('@/lib/funnel');
const { GUEST_EMAIL_DOMAIN } = await import('@/lib/guest');

const SECRET = 'test-auth-secret-for-guest-promotion';
const GUEST_CREATED_AT = new Date('2026-11-20T10:00:00.000Z');
const FUNNEL_GUEST = 'funnel-guest-0123456789ab';

function addGuest(id: string, overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id,
    email: `guest_${id}@${GUEST_EMAIL_DOMAIN}`,
    password: null,
    name: null,
    image: null,
    role: 'USER',
    isGuest: true,
    emailVerified: null,
    guestLastActiveAt: GUEST_CREATED_AT,
    createdAt: GUEST_CREATED_AT,
    updatedAt: GUEST_CREATED_AT,
    ...overrides,
  };
  db.users.push(row as unknown as Record<string, unknown>);
  return row;
}

/** Mints the cookie POST /api/auth/guest would set for this guest row. */
async function guestCookie(id: string, issuedAt = Math.floor(GUEST_CREATED_AT.getTime() / 1000)) {
  const token = await encode({
    token: { id, sub: id, role: 'USER', email: 'x', isGuest: true, sessionIssuedAt: issuedAt },
    secret: SECRET,
    maxAge: 60,
  });
  return `next-auth.session-token=${token}; clickmoji_funnel_guest=${encodeURIComponent(
    signGuestId(FUNNEL_GUEST) ?? ''
  )}`;
}

function register(
  body: Record<string, string>,
  cookie: string | null = null,
  locale = 'ru'
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    cookie: `NEXT_LOCALE=${locale}${cookie ? `; ${cookie}` : ''}`,
  };
  return POST(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Shopper', password: 'password1', ...body }),
    })
  );
}

function userRows() {
  return db.users as unknown as Row[];
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.AUTH_SECRET = SECRET;
  delete process.env.NEXTAUTH_SECRET;
  db.users = [];
  db.funnel = [];
  db.deletedUserIds = [];
  db.listCreates = 0;
  db.userCreates = 0;
  db.emailGate = null;
  db.emailError = null;
  db.verificationRequired = false;
  db.mailSent = 0;
});

describe('POST /api/auth/register with a guest session', () => {
  it('promotes the guest row in place: same id, lists kept, no second user', async () => {
    addGuest('guest-1');

    const response = await register({ email: 'Shopper@Example.com' }, await guestCookie('guest-1'));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.promoted).toBe(true);
    expect(body.user.id).toBe('guest-1');
    expect(body.user.email).toBe('shopper@example.com');
    expect(userRows()).toHaveLength(1);
    expect(db.userCreates).toBe(0);
    expect(db.listCreates).toBe(0);
    expect(db.deletedUserIds).toEqual([]);

    const row = userRows()[0];
    expect(row).toMatchObject({ id: 'guest-1', isGuest: false, name: 'Shopper' });
    expect(row.password).toBe('hashed:password1');
    expect(row.emailVerified).toBeInstanceOf(Date);
  });

  it('writes one GUEST_REGISTERED on the guest chain, not a REGISTER, owned by the same User.id', async () => {
    addGuest('guest-2');

    await register({ email: 'two@example.com' }, await guestCookie('guest-2'));

    expect(db.funnel.filter((event) => event.type === 'REGISTER')).toEqual([]);
    expect(db.funnel.filter((event) => event.type === 'GUEST_REGISTERED')).toEqual([
      expect.objectContaining({
        type: 'GUEST_REGISTERED',
        userId: 'guest-2',
        guestId: FUNNEL_GUEST,
      }),
    ]);
  });

  it('replaces the guest cookie with an ordinary session for the same id', async () => {
    addGuest('guest-3');

    const response = await register({ email: 'three@example.com' }, await guestCookie('guest-3'));
    const setCookie = response.headers.get('set-cookie') ?? '';
    const value = /next-auth\.session-token=([^;]+)/.exec(setCookie)?.[1];

    expect(value).toBeTruthy();
    const claims = await decode({ token: value!, secret: SECRET });
    expect(claims).toMatchObject({ id: 'guest-3', sub: 'guest-3', isGuest: false, role: 'USER' });
    expect(claims?.sessionIssuedAt as number).toBeGreaterThanOrEqual(
      Math.floor(GUEST_CREATED_AT.getTime() / 1000)
    );
  });

  it('keeps the account unverified and reports the email when verification is required', async () => {
    db.verificationRequired = true;
    addGuest('guest-4');

    const response = await register({ email: 'four@example.com' }, await guestCookie('guest-4'));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ emailSent: true, requiresEmailVerification: true });
    expect(userRows()[0].emailVerified).toBeNull();
  });

  it('refuses an email that another account already holds, and leaves the guest untouched', async () => {
    addGuest('guest-5');
    addGuest('other-account', {
      email: 'taken@example.com',
      isGuest: false,
      password: 'hashed:x',
    });

    const response = await register({ email: 'taken@example.com' }, await guestCookie('guest-5'));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Эта почта уже зарегистрирована — войдите');
    expect(userRows().find((row) => row.id === 'guest-5')).toMatchObject({ isGuest: true });
  });

  it('refuses a stale guest token whose row is already an account, and creates nothing', async () => {
    addGuest('guest-6', { isGuest: false, email: 'done@example.com', password: 'hashed:p' });
    const staleCookie = await guestCookie('guest-6');

    const response = await register({ email: 'second@example.com' }, staleCookie);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Эта почта уже зарегистрирована — войдите');
    expect(db.userCreates).toBe(0);
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0].email).toBe('done@example.com');
  });

  it('a signed guest whose row cleanup removed fails as expired: no account, cookie cleared', async () => {
    const response = await register(
      { email: 'fresh@example.com' },
      await guestCookie('gone-guest')
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('Гостевая сессия истекла. Начните покупки заново.');
    expect(response.headers.get('set-cookie')).toMatch(/next-auth\.session-token=;.*Max-Age=0/);
    expect(db.userCreates).toBe(0);
    expect(userRows()).toHaveLength(0);
    expect(db.listCreates).toBe(0);
  });

  it('a signed guest token older than its row (stale) fails as expired and creates no account', async () => {
    addGuest('guest-stale', {
      createdAt: new Date(GUEST_CREATED_AT.getTime() + 60_000),
    });

    const response = await register(
      { email: 'stale@example.com' },
      await guestCookie('guest-stale')
    );

    expect(response.status).toBe(401);
    expect(db.userCreates).toBe(0);
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0]).toMatchObject({ id: 'guest-stale', isGuest: true });
  });

  it('a signed-out visitor with no guest session still registers as an ordinary account', async () => {
    const response = await register({ email: 'plain@example.com' });

    expect(response.status).toBe(201);
    expect((await response.json()).promoted).toBeUndefined();
    expect(db.userCreates).toBe(1);
  });

  it('with verification required, promotes without a session and clears the guest cookie', async () => {
    db.verificationRequired = true;
    addGuest('guest-v');

    const response = await register({ email: 'v@example.com' }, await guestCookie('guest-v'));

    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie') ?? '').not.toMatch(/next-auth\.session-token=[^;]+;/);
    expect(response.headers.get('set-cookie')).toMatch(/next-auth\.session-token=;.*Max-Age=0/);
    expect(db.mailSent).toBe(1);
    expect(userRows()[0]).toMatchObject({ id: 'guest-v', isGuest: false, emailVerified: null });
  });

  it('an email taken by another account sends no verification mail and promotes nothing', async () => {
    db.verificationRequired = true;
    addGuest('guest-t');
    addGuest('owner', { email: 'busy@example.com', isGuest: false, password: 'hashed:x' });

    const response = await register({ email: 'busy@example.com' }, await guestCookie('guest-t'));

    expect(response.status).toBe(400);
    expect(db.mailSent).toBe(0);
    expect(userRows().find((row) => row.id === 'guest-t')).toMatchObject({ isGuest: true });
  });

  it('never deletes the guest when the verification email fails; the guest stays a guest', async () => {
    db.verificationRequired = true;
    db.emailError = new Error('SMTP down');
    addGuest('guest-7');

    const response = await register({ email: 'seven@example.com' }, await guestCookie('guest-7'));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe(
      'Не удалось отправить письмо подтверждения. Попробуйте позже.'
    );
    expect(db.deletedUserIds).toEqual([]);
    expect(userRows()).toEqual([
      expect.objectContaining({ id: 'guest-7', isGuest: true, password: null }),
    ]);

    // The guest can retry once the mail works.
    db.emailError = null;
    const retry = await register({ email: 'seven@example.com' }, await guestCookie('guest-7'));
    expect(retry.status).toBe(201);
    expect(userRows()[0]).toMatchObject({ id: 'guest-7', isGuest: false });
  });

  it('a retry with the same cookie after success creates no second account', async () => {
    addGuest('guest-8');
    const cookie = await guestCookie('guest-8');

    const first = await register({ email: 'eight@example.com' }, cookie);
    const second = await register({ email: 'eight@example.com' }, cookie);

    expect(first.status).toBe(201);
    expect(second.status).toBe(400);
    expect(userRows()).toHaveLength(1);
    expect(db.userCreates).toBe(0);
  });

  it('two simultaneous registrations of one guest: exactly one account, same id', async () => {
    addGuest('guest-9');
    const cookie = await guestCookie('guest-9');

    const [a, b] = await Promise.all([
      register({ email: 'alpha@example.com' }, cookie),
      register({ email: 'beta@example.com' }, cookie),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0]).toMatchObject({ id: 'guest-9', isGuest: false });
    expect(db.userCreates).toBe(0);
    expect(db.funnel.filter((event) => event.type === 'GUEST_REGISTERED')).toHaveLength(1);
    expect(db.funnel.filter((event) => event.type === 'REGISTER')).toHaveLength(0);
  });

  it('two guests racing for one email: one promotes, the other stays a guest', async () => {
    addGuest('guest-a');
    addGuest('guest-b');

    const [a, b] = await Promise.all([
      register({ email: 'same@example.com' }, await guestCookie('guest-a')),
      register({ email: 'same@example.com' }, await guestCookie('guest-b')),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 400]);
    const promoted = userRows().filter((row) => !row.isGuest);
    expect(promoted).toHaveLength(1);
    expect(userRows().filter((row) => row.isGuest)).toHaveLength(1);
    expect(db.userCreates).toBe(0);
  });

  it('cleanup cannot remove a guest once its registration has begun', async () => {
    addGuest('guest-10', { guestLastActiveAt: new Date('2026-09-01T00:00:00.000Z') });
    let release!: () => void;
    db.emailGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    db.verificationRequired = true;

    const pending = register({ email: 'ten@example.com' }, await guestCookie('guest-10'));

    // Wait until the route is parked inside the email send, after cleanup protection ran.
    const staleActivity = new Date('2026-09-01T00:00:00.000Z').getTime();
    await vi.waitFor(() => {
      const row = userRows().find((candidate) => candidate.id === 'guest-10');
      expect(row?.guestLastActiveAt?.getTime()).not.toBe(staleActivity);
    });

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const removed = await fakePrisma.user.deleteMany({ where: inactiveGuestWhere(cutoff) });
    expect(removed.count).toBe(0);
    expect(userRows().map((row) => row.id)).toContain('guest-10');

    release();
    const response = await pending;
    expect(response.status).toBe(201);
    expect(userRows()[0]).toMatchObject({ id: 'guest-10', isGuest: false });
  });
});
