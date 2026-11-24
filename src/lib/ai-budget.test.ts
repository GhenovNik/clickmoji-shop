// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ZERO = BigInt(0);

const dbState = vi.hoisted(() => ({
  rows: new Map<string, { reservedMicroUsd: bigint; spentMicroUsd: bigint }>(),
  failReserve: false,
  failReconcile: false,
  monthlyCalls: [] as Array<{ sql: string; monthKey: string }>,
  dailyCounts: new Map<string, number>(),
  sdkTextCalls: [] as Array<{ model: string; prompt: string }>,
  sdkTextBehavior: vi.fn(),
  sdkImageCalls: [] as Array<{ provider: string; model: string }>,
  sdkImageBehavior: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('ai_monthly_budgets')) {
        if (sql.includes('INSERT INTO ai_monthly_budgets')) {
          if (dbState.failReserve) {
            throw new Error('private pg connection error');
          }
          const monthStart = values[0] as Date;
          const ceiling = BigInt(values[1] as bigint | number);
          const limit = BigInt(values[values.length - 1] as bigint | number);
          const key = monthStart.toISOString();
          dbState.monthlyCalls.push({ sql: 'reserve', monthKey: key });
          const current = dbState.rows.get(key) ?? { reservedMicroUsd: ZERO, spentMicroUsd: ZERO };
          if (current.spentMicroUsd + current.reservedMicroUsd + ceiling > limit) {
            return [];
          }
          const updated = {
            reservedMicroUsd: current.reservedMicroUsd + ceiling,
            spentMicroUsd: current.spentMicroUsd,
          };
          dbState.rows.set(key, updated);
          return [updated];
        }
        if (sql.includes('UPDATE ai_monthly_budgets')) {
          if (dbState.failReconcile) {
            throw new Error('private pg reconcile failure');
          }
          const ceiling = BigInt(values[0] as bigint | number);
          const actual = BigInt(values[1] as bigint | number);
          const monthStart = values[2] as Date;
          const key = monthStart.toISOString();
          dbState.monthlyCalls.push({ sql: 'reconcile', monthKey: key });
          const current = dbState.rows.get(key);
          if (!current) return [];
          const updated = {
            reservedMicroUsd:
              current.reservedMicroUsd > ceiling ? current.reservedMicroUsd - ceiling : ZERO,
            spentMicroUsd: current.spentMicroUsd + actual,
          };
          dbState.rows.set(key, updated);
          return [updated];
        }
      }
      if (sql.includes('ai_usage_counters')) {
        const userId = String(values[0]);
        const windowStart = (values[1] as Date).toISOString();
        const limit = Number(values[values.length - 1]);
        const key = `${userId}:${windowStart}`;
        const count = dbState.dailyCounts.get(key) ?? 0;
        if (count >= limit) return [];
        dbState.dailyCounts.set(key, count + 1);
        return [{ count: count + 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('ai_usage_counters')) {
        const userId = String(values[0]);
        const windowStart = (values[1] as Date).toISOString();
        const key = `${userId}:${windowStart}`;
        const count = dbState.dailyCounts.get(key) ?? 0;
        if (count > 0) dbState.dailyCounts.set(key, count - 1);
        return 1;
      }
      throw new Error(`Unexpected executeRaw SQL: ${sql}`);
    }),
  },
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { model: string; contents: string }) => {
        dbState.sdkTextCalls.push({ model: params.model, prompt: params.contents });
        return dbState.sdkTextBehavior(params);
      },
      generateImages: async (params: { model: string }) => {
        dbState.sdkImageCalls.push({ provider: 'gemini', model: params.model });
        return dbState.sdkImageBehavior(params);
      },
    };
  },
}));

vi.mock('openai', () => ({
  default: class {
    images = {
      generate: async (params: { model: string }) => {
        dbState.sdkImageCalls.push({ provider: 'gpt-image', model: params.model });
        return dbState.sdkImageBehavior(params);
      },
    };
  },
}));

const {
  AI_MONTHLY_BUDGET_USD_ENV,
  DEFAULT_AI_MONTHLY_BUDGET_MICRO_USD,
  parseMonthlyBudgetMicroUsd,
  reconcileMonthlyAiBudget,
  reserveMonthlyAiBudget,
  startOfUtcMonth,
} = await import('@/lib/ai-budget');
const {
  calculateImageAttemptCostMicroUsd,
  calculateTextAttemptCostMicroUsd,
  estimateImageCallCeilingMicroUsd,
  estimateTextCallCeilingMicroUsd,
} = await import('@/lib/ai-pricing');
const { runTextAiCall } = await import('@/lib/text-ai-call');
const { runImageAiCall } = await import('@/lib/image-ai-call');
const { generateGoogleText } = await import('@/lib/services/google-text-generation');
const { generateEmojiImage } = await import('@/lib/services/emoji-assets');

beforeEach(() => {
  vi.clearAllMocks();
  dbState.rows.clear();
  dbState.dailyCounts.clear();
  dbState.monthlyCalls.length = 0;
  dbState.sdkTextCalls.length = 0;
  dbState.sdkImageCalls.length = 0;
  dbState.failReserve = false;
  dbState.failReconcile = false;
  delete process.env[AI_MONTHLY_BUDGET_USD_ENV];
  delete process.env.AI_PROVIDER;
  delete process.env.GOOGLE_TEXT_MODEL;
  delete process.env.GOOGLE_TEXT_MODEL_FALLBACK;
  delete process.env.GOOGLE_IMAGE_MODEL;
  delete process.env.OPENAI_IMAGE_MODEL;
  process.env.GOOGLE_GENAI_API_KEY = 'synthetic-google-key';
  process.env.OPENAI_API_KEY = 'synthetic-openai-key';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('monthly AI budget configuration parsing', () => {
  it('uses the safe $10.00 default when unset or blank and parses valid decimals to exact micro-USD', () => {
    expect(parseMonthlyBudgetMicroUsd()).toEqual({
      ok: true,
      limitMicroUsd: DEFAULT_AI_MONTHLY_BUDGET_MICRO_USD,
    });
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = '   ';
    expect(parseMonthlyBudgetMicroUsd()).toEqual({
      ok: true,
      limitMicroUsd: DEFAULT_AI_MONTHLY_BUDGET_MICRO_USD,
    });
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = '0';
    expect(parseMonthlyBudgetMicroUsd()).toEqual({ ok: true, limitMicroUsd: ZERO });
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = ' 12.345678 ';
    expect(parseMonthlyBudgetMicroUsd()).toEqual({
      ok: true,
      limitMicroUsd: BigInt(12_345_678),
    });
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = '0.000001';
    expect(parseMonthlyBudgetMicroUsd()).toEqual({ ok: true, limitMicroUsd: BigInt(1) });
  });

  it.each(['-1', '-0.01', 'abc', 'NaN', 'Infinity', '1e5', '1.1234567', '$10', '1000001'])(
    'fails closed on malformed value %s without logging the raw value',
    async (badValue) => {
      process.env[AI_MONTHLY_BUDGET_USD_ENV] = badValue;
      expect(parseMonthlyBudgetMicroUsd()).toEqual({ ok: false, code: 'INVALID_MONTHLY_BUDGET' });

      const reservation = await reserveMonthlyAiBudget({ ceilingMicroUsd: BigInt(1_000) });
      expect(reservation).toMatchObject({ allowed: false, reason: 'invalid_config' });
      const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
      expect(logged).toContain('INVALID_MONTHLY_BUDGET');
      expect(logged).not.toContain(badValue);
    }
  );
});

describe('exact boundary & accounting failure behavior', () => {
  it('allows exact remaining === ceiling and rejects ceiling + 1 micro-USD', async () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const monthKey = startOfUtcMonth(now).toISOString();
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = '0.050000'; // 50,000 micro-USD

    dbState.rows.set(monthKey, { reservedMicroUsd: ZERO, spentMicroUsd: BigInt(10_000) });
    const exactOk = await reserveMonthlyAiBudget({ ceilingMicroUsd: BigInt(40_000), now });
    expect(exactOk).toMatchObject({
      allowed: true,
      reservedMicroUsd: BigInt(40_000),
      spentMicroUsd: BigInt(10_000),
    });

    // Reset to 10,001 spent -> 39,999 remaining < 40,000 ceiling (1 micro-USD short).
    dbState.rows.set(monthKey, { reservedMicroUsd: ZERO, spentMicroUsd: BigInt(10_001) });
    const oneShort = await reserveMonthlyAiBudget({ ceilingMicroUsd: BigInt(40_000), now });
    expect(oneShort).toMatchObject({ allowed: false, reason: 'exhausted' });
  });

  it('rejects first reservation of month when cap is 0 or smaller than ceiling without inserting a row', async () => {
    const now = new Date('2026-11-15T12:00:00Z');
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = '0';
    expect(await reserveMonthlyAiBudget({ ceilingMicroUsd: BigInt(1_000), now })).toMatchObject({
      allowed: false,
      reason: 'exhausted',
    });
    expect(dbState.rows.size).toBe(0);

    process.env[AI_MONTHLY_BUDGET_USD_ENV] = '0.039999';
    expect(await reserveMonthlyAiBudget({ ceilingMicroUsd: BigInt(40_000), now })).toMatchObject({
      allowed: false,
      reason: 'exhausted',
    });
    expect(dbState.rows.size).toBe(0);
  });

  it('reconciliation failures log safe error codes and retain conservative ceiling without throwing', async () => {
    const now = new Date('2026-11-15T12:00:00Z');
    dbState.rows.set(startOfUtcMonth(now).toISOString(), {
      reservedMicroUsd: BigInt(40_000),
      spentMicroUsd: ZERO,
    });
    dbState.failReconcile = true;

    const ok = await reconcileMonthlyAiBudget({
      monthStart: startOfUtcMonth(now),
      ceilingMicroUsd: BigInt(40_000),
      actualMicroUsd: BigInt(10_000),
    });
    expect(ok).toBe(false);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain('private pg reconcile failure');
    expect(dbState.rows.get(startOfUtcMonth(now).toISOString())?.reservedMicroUsd).toBe(
      BigInt(40_000)
    );
  });
});

describe('cost calculation & provider reconciliation', () => {
  it('reconciles multi-attempt text fallback using actual usageMetadata and ignores non-billable 503s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
    vi.stubEnv('GOOGLE_TEXT_MODEL', 'gemini-3.8-flash');
    vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', 'gemini-2.5-flash');
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '1.00');

    let attempt = 0;
    dbState.sdkTextBehavior.mockImplementation(async () => {
      attempt += 1;
      if (attempt < 3) {
        throw Object.assign(new Error('transient overload'), { status: 503 });
      }
      return {
        text: '{"ok":true}',
        usageMetadata: {
          promptTokenCount: 1_000,
          candidatesTokenCount: 200,
          thoughtsTokenCount: 100,
        },
      };
    });

    const pending = runTextAiCall({ id: 'u1', role: 'USER' }, 'en', () =>
      generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Buy milk' })
    );
    await vi.runAllTimersAsync();
    const res = await pending;

    expect(res).toEqual({ text: '{"ok":true}', model: 'gemini-2.5-flash' });
    expect(dbState.sdkTextCalls.map((c) => c.model)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-2.5-flash',
    ]);

    // gemini-2.5-flash: 1000 * 0.3 + (200 + 100) * 2.5 = 300 + 750 = 1050 micro-USD.
    const row = dbState.rows.get('2026-11-01T00:00:00.000Z');
    expect(row).toEqual({ reservedMicroUsd: ZERO, spentMicroUsd: BigInt(1_050) });
  });

  it('uses conservative estimate when usageMetadata is absent or corrupted (NaN/negative)', () => {
    const cleanMissing = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: 200,
      outcome: 'ok',
    });
    const corrupted = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: 200,
      outcome: 'ok',
      usageMetadata: {
        promptTokenCount: Number.NaN,
        candidatesTokenCount: -50,
        totalTokenCount: Number.POSITIVE_INFINITY,
      },
    });
    expect(cleanMissing).toBeGreaterThan(ZERO);
    expect(corrupted).toBe(cleanMissing);

    const openAiMissingUsage = calculateImageAttemptCostMicroUsd({
      provider: 'gpt-image',
      model: 'gpt-image-2.5-flare',
      promptChars: 300,
      outcome: 'ok',
    });
    expect(openAiMissingUsage).toBe(
      estimateImageCallCeilingMicroUsd({ provider: 'gpt-image', model: 'gpt-image-2.5-flare' })
    );

    const openAiWithUsage = calculateImageAttemptCostMicroUsd({
      provider: 'gpt-image',
      model: 'gpt-image-2.5-flare',
      promptChars: 300,
      outcome: 'ok',
      openaiUsage: {
        input_tokens: 100,
        output_tokens: 1000,
        input_tokens_details: { text_tokens: 100, image_tokens: 0 },
        output_tokens_details: { text_tokens: 0, image_tokens: 1000 },
      },
    });
    // 100 * 5 + 1000 * 30 = 500 + 30_000 = 30_500 micro-USD.
    expect(openAiWithUsage).toBe(BigInt(30_500));
  });

  it('releases full reservation ($0 spent) when image provider rejects with 429 or missing key', async () => {
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '0.20');
    vi.stubEnv('AI_PROVIDER', 'gpt-image');
    delete process.env.OPENAI_API_KEY;

    await expect(
      runImageAiCall({ id: 'admin-1', role: 'ADMIN' }, 'en', () =>
        generateEmojiImage({ productName: 'Milk' })
      )
    ).rejects.toThrow(/missing-key/);

    const monthKey = startOfUtcMonth(new Date()).toISOString();
    expect(dbState.rows.get(monthKey)).toEqual({ reservedMicroUsd: ZERO, spentMicroUsd: ZERO });
  });

  it('reconciles the captured UTC month even when a request crosses month boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-30T23:59:59.500Z'));
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '1.00');

    dbState.sdkTextBehavior.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-12-01T00:00:01.000Z'));
      return {
        text: '{"ok":true}',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 },
      };
    });

    await runTextAiCall({ id: 'u1', role: 'USER' }, 'en', () =>
      generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Milk' })
    );

    expect(dbState.rows.get('2026-11-01T00:00:00.000Z')).toEqual({
      reservedMicroUsd: ZERO,
      spentMicroUsd: BigInt(350), // 100*0.5 + 100*3.0
    });
    expect(dbState.rows.has('2026-12-01T00:00:00.000Z')).toBe(false);
  });

  it('under barrier-controlled concurrency, caps simultaneous reservations at exact ceiling capacity and frees unused reserve after reconciliation', async () => {
    const ceiling = estimateTextCallCeilingMicroUsd();
    // Allow exactly 2 concurrent text ceilings in the budget.
    const capMicroUsd = ceiling * BigInt(2);
    const whole = capMicroUsd / BigInt(1_000_000);
    const frac = String(capMicroUsd % BigInt(1_000_000)).padStart(6, '0');
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, `${whole}.${frac}`);

    let releaseSdk!: () => void;
    const sdkBarrier = new Promise<void>((resolve) => {
      releaseSdk = resolve;
    });
    let enteredSdk = 0;
    let resolveTwoInFlight!: () => void;
    const twoInFlight = new Promise<void>((resolve) => {
      resolveTwoInFlight = resolve;
    });

    dbState.sdkTextBehavior.mockImplementation(async () => {
      enteredSdk += 1;
      if (enteredSdk === 2) resolveTwoInFlight();
      await sdkBarrier;
      return {
        text: '{"ok":true}',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 },
      };
    });

    const calls = Array.from({ length: 6 }, (_, i) =>
      runTextAiCall({ id: `user-${i}`, role: 'USER' }, 'en', () =>
        generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Milk' })
      )
    );

    await twoInFlight;
    releaseSdk();
    const outcomes = await Promise.all(calls);

    const rejected = outcomes.filter((o): o is Response => o instanceof Response);
    const succeeded = outcomes.filter((o) => !(o instanceof Response));
    expect(succeeded).toHaveLength(2);
    expect(rejected).toHaveLength(4);
    expect(rejected.every((r) => r.status === 503)).toBe(true);
    expect(dbState.sdkTextCalls).toHaveLength(2);

    // After reconciliation, unused reserve is freed (only 2 * 350 = 700 micro-USD spent).
    const nextOutcome = await runTextAiCall({ id: 'user-next', role: 'USER' }, 'en', () =>
      generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Bread' })
    );
    expect(nextOutcome).not.toBeInstanceOf(Response);
  });
});
