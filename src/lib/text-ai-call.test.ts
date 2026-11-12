// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  reserve: vi.fn(),
  refund: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { $queryRaw: state.reserve, $executeRaw: state.refund },
}));

const { runTextAiCall } = await import('./text-ai-call');
const { GoogleTextUnavailableError } = await import('./services/text-ai-errors');
const user = { id: 'test-user', role: 'USER' };
const key = (userId: unknown, date: unknown) => `${userId}:${(date as Date).toISOString()}`;

beforeEach(() => {
  vi.resetAllMocks();
  state.counters.clear();
  process.env.AI_DAILY_CALLS_PER_USER = '30';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  state.reserve.mockImplementation(async (_strings, userId, windowStart, limit) => {
    const id = key(userId, windowStart);
    const count = state.counters.get(id) ?? 0;
    if (count >= limit) return [];
    state.counters.set(id, count + 1);
    return [{ count: count + 1 }];
  });
  state.refund.mockImplementation(async (strings: TemplateStringsArray, userId, windowStart) => {
    const sql = strings.join('?');
    expect(sql).toMatch(/UPDATE ai_usage_counters/);
    expect(sql).toMatch(/SET "count" = "count" - 1/);
    expect(sql).toMatch(/WHERE "userId" = \? AND "windowStart" = \? AND "count" > 0/);
    const id = key(userId, windowStart);
    const count = state.counters.get(id) ?? 0;
    if (!count) return 0;
    state.counters.set(id, count - 1);
    return 1;
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.AI_DAILY_CALLS_PER_USER;
});

describe('private text reservation compensation', () => {
  it('targets the original UTC day when a failed operation crosses midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T23:59:59.999Z'));
    const error = new Error('synthetic parse failure');
    const operation = vi.fn(async () => {
      vi.setSystemTime(new Date('2026-11-04T00:00:01Z'));
      // A different operation has already charged the new day.
      state.counters.set(key(user.id, new Date('2026-11-04T00:00:00Z')), 1);
      throw error;
    });
    await expect(runTextAiCall(user, 'ru', operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(state.refund).toHaveBeenCalledTimes(1);
    expect(state.refund.mock.calls[0].slice(1)).toEqual([
      user.id,
      new Date('2026-11-03T00:00:00Z'),
    ]);
    expect(state.counters.get(key(user.id, new Date('2026-11-03T00:00:00Z')))).toBe(0);
    expect(state.counters.get(key(user.id, new Date('2026-11-04T00:00:00Z')))).toBe(1);
  });

  it('captures the UTC window before even a slow reservation crosses midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T23:59:59.999Z'));
    const reserve = state.reserve.getMockImplementation()!;
    state.reserve.mockImplementationOnce(async (...args) => {
      const result = await reserve(...args);
      vi.setSystemTime(new Date('2026-11-04T00:00:01Z'));
      return result;
    });
    const response = await runTextAiCall(user, 'en', async () => {
      throw new GoogleTextUnavailableError();
    });
    expect((response as Response).status).toBe(503);
    expect(state.refund).toHaveBeenCalledTimes(1);
    expect(state.refund.mock.calls[0].slice(1)).toEqual([
      user.id,
      new Date('2026-11-03T00:00:00Z'),
    ]);
    expect([...state.counters.values()]).toEqual([0]);
  });

  it('concurrent successes and failures retain exactly the successful charges', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operations = Array.from({ length: 20 }, (_, index) =>
      runTextAiCall(user, 'en', async () => {
        await ready;
        if (index % 2) throw new GoogleTextUnavailableError();
        return index;
      })
    );
    release();
    const results = await Promise.all(operations);
    expect(results.filter((value) => value instanceof Response)).toHaveLength(10);
    expect(state.reserve).toHaveBeenCalledTimes(20);
    expect(state.refund).toHaveBeenCalledTimes(10);
    expect([...state.counters.values()]).toEqual([10]);
  });

  it.each(['off', 'exhausted', 'database'])(
    'never refunds a denied %s reservation',
    async (reason) => {
      if (reason === 'off') process.env.AI_DAILY_CALLS_PER_USER = '0';
      if (reason === 'exhausted') state.reserve.mockResolvedValue([]);
      if (reason === 'database') state.reserve.mockRejectedValue(new Error('private DB detail'));
      const operation = vi.fn();
      const result = await runTextAiCall(user, 'en', operation);
      expect(result).toBeInstanceOf(Response);
      expect(operation).not.toHaveBeenCalled();
      expect(state.refund).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
        'private DB detail'
      );
    }
  );

  it('does not blindly retry an ambiguous compensation DB failure', async () => {
    state.refund.mockRejectedValue(new Error('private connection detail'));
    const operation = vi.fn(async () => {
      throw new GoogleTextUnavailableError();
    });
    const response = await runTextAiCall(user, 'en', operation);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
    expect(state.refund).toHaveBeenCalledTimes(1);
    expect([...state.counters.values()]).toEqual([1]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'private connection detail'
    );
  });

  it('returns a successful result without exposing a reusable refund handle', async () => {
    const value = { result: 'parsed' };
    expect(await runTextAiCall(user, 'en', async () => value)).toBe(value);
    expect(state.refund).not.toHaveBeenCalled();
    expect([...state.counters.values()]).toEqual([1]);
  });
});
