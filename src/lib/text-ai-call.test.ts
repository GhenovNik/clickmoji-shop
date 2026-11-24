// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  monthly: { reserved: BigInt(0), spent: BigInt(0) },
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
  state.monthly = { reserved: BigInt(0), spent: BigInt(0) };
  process.env.AI_DAILY_CALLS_PER_USER = '30';
  delete process.env.AI_MONTHLY_BUDGET_USD;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  state.reserve.mockImplementation(async (strings: TemplateStringsArray, ...args: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('INSERT INTO ai_monthly_budgets')) {
      const ceiling = BigInt(args[1] as bigint | number);
      const limit = BigInt(args[args.length - 1] as bigint | number);
      if (state.monthly.spent + state.monthly.reserved + ceiling > limit) return [];
      state.monthly.reserved += ceiling;
      return [{ reservedMicroUsd: state.monthly.reserved, spentMicroUsd: state.monthly.spent }];
    }
    if (sql.includes('UPDATE ai_monthly_budgets')) {
      const ceiling = BigInt(args[0] as bigint | number);
      const actual = BigInt(args[1] as bigint | number);
      state.monthly.reserved =
        state.monthly.reserved > ceiling ? state.monthly.reserved - ceiling : BigInt(0);
      state.monthly.spent += actual;
      return [{ reservedMicroUsd: state.monthly.reserved, spentMicroUsd: state.monthly.spent }];
    }
    const [userId, windowStart, limit] = args;
    const id = key(userId, windowStart);
    const count = state.counters.get(id) ?? 0;
    if (count >= Number(limit)) return [];
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
    const dailyReserveCalls = state.reserve.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('ai_usage_counters')
    );
    const monthlyReserveCalls = state.reserve.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('INSERT INTO ai_monthly_budgets')
    );
    const monthlyReconcileCalls = state.reserve.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('UPDATE ai_monthly_budgets')
    );
    expect(dailyReserveCalls).toHaveLength(20);
    expect(monthlyReserveCalls).toHaveLength(20);
    expect(monthlyReconcileCalls).toHaveLength(20);
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

  it('does not count daily exhaustion twice in reserve mock assertions', async () => {
    state.reserve.mockImplementation(async (strings: TemplateStringsArray, ...args: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('INSERT INTO ai_monthly_budgets')) {
        const ceiling = BigInt(args[1] as bigint | number);
        state.monthly.reserved += ceiling;
        return [{ reservedMicroUsd: state.monthly.reserved, spentMicroUsd: state.monthly.spent }];
      }
      if (sql.includes('UPDATE ai_monthly_budgets')) {
        const ceiling = BigInt(args[0] as bigint | number);
        state.monthly.reserved =
          state.monthly.reserved > ceiling ? state.monthly.reserved - ceiling : BigInt(0);
        return [{ reservedMicroUsd: state.monthly.reserved, spentMicroUsd: state.monthly.spent }];
      }
      return [];
    });
    const operation = vi.fn();
    const result = await runTextAiCall(user, 'en', operation);
    expect((result as Response).status).toBe(429);
    expect(operation).not.toHaveBeenCalled();
    expect(state.monthly.reserved).toBe(BigInt(0));
    expect(state.monthly.spent).toBe(BigInt(0));
  });

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
