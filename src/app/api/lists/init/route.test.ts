// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeInitDb } from '@/test/fake-init-db';

// Starter lists for an account that has none: the same set and order as email registration.

const holder = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeInitDb>,
  requireUser: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({ requireUser: holder.requireUser }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_target, prop) => Reflect.get(holder.db.prisma, prop) }),
}));

const { POST } = await import('./route');

const EN_STARTERS = ['Main', 'Weekend', 'Holidays', 'Party', 'Urgent'];
const RU_STARTERS = ['Основной', 'На выходные', 'Праздники', 'Для вечеринки', 'Срочное'];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function init(locale = 'en') {
  return POST(
    new Request('http://localhost/api/lists/init', {
      method: 'POST',
      headers: { cookie: `NEXT_LOCALE=${locale}` },
    })
  );
}

const listNames = () => holder.db.state.lists.map((list) => list.name);
const activeNames = () =>
  holder.db.state.lists.filter((list) => list.isActive).map((list) => list.name);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  holder.requireUser.mockReset().mockResolvedValue({
    session: { user: { id: 'user-1', role: 'USER' } },
  });
  holder.db = createFakeInitDb();
});

describe('POST /api/lists/init', () => {
  it('creates the shared starter set, main active, when the account has no lists', async () => {
    const response = await init();

    expect(response.status).toBe(200);
    expect(listNames()).toEqual(EN_STARTERS);
    expect(activeNames()).toEqual(['Main']);
    expect(holder.db.calls.filter((call) => call === 'list.createMany')).toHaveLength(1);
    expect(await response.json()).toHaveLength(5);
  });

  it('creates Russian starter names for NEXT_LOCALE=ru', async () => {
    const response = await init('ru');

    expect(response.status).toBe(200);
    expect(listNames()).toEqual(RU_STARTERS);
    expect(activeNames()).toEqual(['Основной']);
    expect(holder.db.calls.filter((call) => call === 'list.createMany')).toHaveLength(1);
  });

  it('creates nothing when the account already has lists', async () => {
    holder.db.state.lists.push({
      id: 'list-mine',
      name: 'Mine',
      isActive: true,
      userId: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const response = await init();

    expect(response.status).toBe(200);
    expect(holder.db.calls).not.toContain('list.createMany');
    expect(listNames()).toEqual(['Mine']);
    expect(await response.json()).toEqual({ message: 'Lists already exist' });
  });

  it('creates one starter set and one active list for two overlapping requests', async () => {
    // The first request stops immediately before createMany; the second starts only then. A
    // serialized implementation makes the second wait on the user-row lock, which releases the
    // barrier through onUserLockWait; the unsynchronized one reaches createMany as well.
    const firstArrived = deferred();
    const secondArrived = deferred();
    const lockWaiting = deferred();
    const release = deferred();
    let createManyCalls = 0;

    holder.db.hooks.beforeListCreateMany = async () => {
      createManyCalls += 1;
      if (createManyCalls === 1) firstArrived.resolve();
      if (createManyCalls === 2) secondArrived.resolve();
      await release.promise;
    };
    holder.db.hooks.onUserLockWait = () => lockWaiting.resolve();

    const first = init();
    await firstArrived.promise;

    const second = init();
    await Promise.race([secondArrived.promise, lockWaiting.promise]);
    release.resolve();

    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(listNames()).toEqual(EN_STARTERS);
    expect(activeNames()).toEqual(['Main']);

    const bodies = await Promise.all(responses.map((response) => response.json()));
    const createdLists = bodies.filter((body) => Array.isArray(body));
    expect(createdLists).toHaveLength(1);
    expect(createdLists[0]).toHaveLength(5);
    expect(bodies.filter((body) => body.message === 'Lists already exist')).toHaveLength(1);
  });

  it('answers 500 and persists nothing when creating the lists fails', async () => {
    holder.db.hooks.beforeListCreateMany = () => {
      throw new Error('connection reset');
    };

    const response = await init();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to initialize lists' });
    expect(holder.db.state.lists).toEqual([]);
  });
});
