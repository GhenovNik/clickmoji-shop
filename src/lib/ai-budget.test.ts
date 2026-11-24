// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ZERO = BigInt(0);

const dbState = vi.hoisted(() => ({
  rows: new Map<string, { reservedMicroUsd: bigint; spentMicroUsd: bigint }>(),
  failReserve: false,
  failReconcile: false,
  monthlyCalls: [] as Array<{ sql: string; monthKey: string; rawSql?: string }>,
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
          dbState.monthlyCalls.push({ sql: 'reconcile', monthKey: key, rawSql: sql });
          const current = dbState.rows.get(key);
          if (!current || current.reservedMicroUsd < ceiling) return [];
          const updated = {
            reservedMicroUsd: current.reservedMicroUsd - ceiling,
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
      generateContent: async (params: {
        model: string;
        contents: string;
        config?: { responseModalities?: string[] };
      }) => {
        if (params.config?.responseModalities?.includes('IMAGE')) {
          dbState.sdkImageCalls.push({ provider: 'gemini', model: params.model });
          return dbState.sdkImageBehavior(params);
        }
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
  MonthlyBudgetAccountingError,
  parseMonthlyBudgetMicroUsd,
  reconcileMonthlyAiBudget,
  reserveMonthlyAiBudget,
  startOfUtcMonth,
} = await import('@/lib/ai-budget');
const {
  IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD,
  MAX_TEXT_OUTPUT_TOKENS,
  TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD,
  UNBOUNDED_OPENAI_IMAGE_MODELS,
  calculateImageAttemptCostMicroUsd,
  calculateTextAttemptCostMicroUsd,
  calculateTextOperationCostMicroUsd,
  estimateBulkProductsPromptTokens,
  estimateImageCallCeilingMicroUsd,
  estimateShoppingListPromptTokens,
  estimateSmartProductPromptTokens,
  estimateTextAttemptCeilingMicroUsd,
  estimateTextCallCeilingMicroUsd,
  promptTokenUpperBound,
} = await import('@/lib/ai-pricing');
const { AiCostUnboundedError } = await import('@/lib/services/emoji-errors');
const { runMonthlyBudgetedTextAiCall, runTextAiCall, MonthlyBudgetBlockedError } =
  await import('@/lib/text-ai-call');
const { runImageAiCall } = await import('@/lib/image-ai-call');
const { generateGoogleText } = await import('@/lib/services/google-text-generation');
const { generateEmojiImage } = await import('@/lib/services/emoji-assets');
const { buildBulkProductsPrompt, buildShoppingListPrompt, buildSmartProductPrompt } =
  await import('@/lib/services/ai-products');

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

  it('reconciliation DB failures log safe error codes, retain conservative ceiling, and propagate MonthlyBudgetAccountingError', async () => {
    const now = new Date('2026-11-15T12:00:00Z');
    dbState.rows.set(startOfUtcMonth(now).toISOString(), {
      reservedMicroUsd: BigInt(40_000),
      spentMicroUsd: ZERO,
    });
    dbState.failReconcile = true;

    await expect(
      reconcileMonthlyAiBudget({
        monthStart: startOfUtcMonth(now),
        ceilingMicroUsd: BigInt(40_000),
        actualMicroUsd: BigInt(10_000),
      })
    ).rejects.toBeInstanceOf(MonthlyBudgetAccountingError);

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain('private pg reconcile failure');
    expect(dbState.rows.get(startOfUtcMonth(now).toISOString())).toEqual({
      reservedMicroUsd: BigInt(40_000),
      spentMicroUsd: ZERO,
    });
  });

  it('reconciliation fails closed on zero returned rows or under-reservation without GREATEST masking', async () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const monthStart = startOfUtcMonth(now);

    // Zero rows: missing month row
    await expect(
      reconcileMonthlyAiBudget({
        monthStart,
        ceilingMicroUsd: BigInt(40_000),
        actualMicroUsd: BigInt(10_000),
      })
    ).rejects.toMatchObject({
      name: 'MonthlyBudgetAccountingError',
      reason: 'settlement_mismatch',
    });

    const sql = dbState.monthlyCalls.at(-1)?.rawSql ?? '';
    expect(sql).not.toMatch(/GREATEST/i);
    expect(sql).toMatch(/"reservedMicroUsd"\s*>=\s*\?/);

    // Under-reserved row: reservedMicroUsd (39_999) < ceiling (40_000) -> 0 rows returned -> throws and leaves row untouched
    dbState.rows.set(monthStart.toISOString(), {
      reservedMicroUsd: BigInt(39_999),
      spentMicroUsd: BigInt(5_000),
    });
    await expect(
      reconcileMonthlyAiBudget({
        monthStart,
        ceilingMicroUsd: BigInt(40_000),
        actualMicroUsd: BigInt(10_000),
      })
    ).rejects.toMatchObject({
      name: 'MonthlyBudgetAccountingError',
      reason: 'settlement_mismatch',
    });
    expect(dbState.rows.get(monthStart.toISOString())).toEqual({
      reservedMicroUsd: BigInt(39_999),
      spentMicroUsd: BigInt(5_000),
    });

    // Negative amounts rejected before DB
    await expect(
      reconcileMonthlyAiBudget({
        monthStart,
        ceilingMicroUsd: BigInt(40_000),
        actualMicroUsd: BigInt(-1),
      })
    ).rejects.toMatchObject({
      name: 'MonthlyBudgetAccountingError',
      reason: 'invalid_settlement_amount',
    });
  });
});

describe('cost calculation & provider reconciliation', () => {
  it('reconciles multi-attempt text fallback using actual usageMetadata and ignores non-billable 429 rejections', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
    vi.stubEnv('GOOGLE_TEXT_MODEL', 'gemini-3.8-flash');
    vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', 'gemini-2.5-flash');
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '2.00');

    let attempt = 0;
    dbState.sdkTextBehavior.mockImplementation(async () => {
      attempt += 1;
      if (attempt < 3) {
        throw Object.assign(new Error('rate limited'), { status: 429 });
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

    // gemini-2.5-flash: 1000 * 0.3 + (200 + 100) * 2.5 = 300 + 750 = 1050 micro-USD; 429 rejections cost $0.
    const row = dbState.rows.get('2026-11-01T00:00:00.000Z');
    expect(row).toEqual({ reservedMicroUsd: ZERO, spentMicroUsd: BigInt(1_050) });
  });

  it('treats ambiguous upstream 503/408/TIMEOUT failures as potentially billed within reserved ceiling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
    vi.stubEnv('GOOGLE_TEXT_MODEL', 'gemini-3.8-flash');
    vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', 'gemini-2.5-flash');
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '2.00');

    const prompt = 'Buy молоко 🥛';
    const promptTokens = promptTokenUpperBound(prompt, TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD);
    const reservedCeiling = estimateTextCallCeilingMicroUsd({ maxPromptTokens: promptTokens });

    let attempt = 0;
    dbState.sdkTextBehavior.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error('gateway overloaded'), { status: 503 });
      }
      if (attempt === 2) {
        throw Object.assign(new Error('network timeout'), { name: 'TimeoutError' });
      }
      return {
        text: '{"ok":true}',
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 0,
          totalTokenCount: 30,
        },
      };
    });

    const pending = runTextAiCall(
      { id: 'u1', role: 'USER' },
      'en',
      () => generateGoogleText({ apiKey: 'synthetic-google-key', prompt }),
      { prompt }
    );
    await vi.runAllTimersAsync();
    await pending;

    const expectedTwoPrimaryFailures =
      BigInt(2) * estimateTextAttemptCeilingMicroUsd('gemini-3.8-flash', promptTokens);
    const expectedThirdAttempt = BigInt(Math.ceil(20 * 0.3) + Math.ceil(10 * 2.5));
    const expectedTotal = expectedTwoPrimaryFailures + expectedThirdAttempt;
    expect(expectedTotal).toBeLessThanOrEqual(reservedCeiling);

    const row = dbState.rows.get('2026-11-01T00:00:00.000Z');
    expect(row).toEqual({ reservedMicroUsd: ZERO, spentMicroUsd: expectedTotal });
  });

  it('uses MAX_TEXT_OUTPUT_TOKENS (4096) and UTF-8 byte input bounds when usageMetadata is missing, partial, or corrupted', () => {
    const prompt = 'Молоко🥛'; // 14 UTF-8 bytes vs 8 UTF-16 chars
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    const cleanMissing = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: prompt.length,
      promptBytes,
      outcome: 'ok',
    });
    const corrupted = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: prompt.length,
      promptBytes,
      outcome: 'ok',
      usageMetadata: {
        promptTokenCount: Number.NaN,
        candidatesTokenCount: -50,
        totalTokenCount: Number.POSITIVE_INFINITY,
      },
    });
    const expectedMissing = estimateTextAttemptCeilingMicroUsd(
      'gemini-3.8-flash',
      promptBytes + TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD
    );
    expect(cleanMissing).toBe(expectedMissing);
    expect(corrupted).toBe(cleanMissing);

    // Partial usage: candidatesTokenCount missing on 'ok' with known thoughtsTokenCount uses the
    // remaining combined output bound (max(0, 4096 - 300) = 3796, total 4096), never exceeding reserved ceiling.
    const partialWithoutTotal = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: prompt.length,
      promptBytes,
      outcome: 'ok',
      usageMetadata: {
        promptTokenCount: 50,
        toolUsePromptTokenCount: 25,
        thoughtsTokenCount: 300,
      },
    });
    // input = 50 + 25 = 75; baseOutput = 300 + (4096 - 300) = 4096 (bounded by MAX_TEXT_OUTPUT_TOKENS)
    expect(partialWithoutTotal).toBe(BigInt(Math.ceil(75 * 1.5) + Math.ceil(4096 * 7.5)));
    expect(partialWithoutTotal).toBeLessThanOrEqual(
      estimateTextAttemptCeilingMicroUsd(
        'gemini-3.8-flash',
        promptBytes + TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD
      )
    );

    // If reported thoughts ever exceed MAX_TEXT_OUTPUT_TOKENS, remaining combined bound clamps to 0.
    const thoughtsExceedingMax = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: prompt.length,
      promptBytes,
      outcome: 'ok',
      usageMetadata: {
        promptTokenCount: 50,
        thoughtsTokenCount: 5000,
      },
    });
    expect(thoughtsExceedingMax).toBe(BigInt(Math.ceil(50 * 1.5) + Math.ceil(5000 * 7.5)));

    // When totalTokenCount is also present and exceeds input + 4096, residual accounts for the excess.
    const partialWithResidual = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: prompt.length,
      promptBytes,
      outcome: 'ok',
      usageMetadata: {
        promptTokenCount: 50,
        toolUsePromptTokenCount: 25,
        thoughtsTokenCount: 300,
        totalTokenCount: 5000,
      },
    });
    // input = 75; baseOutput = 4096; accounted = 4171; residual = 829 -> output = 4925
    expect(partialWithResidual).toBe(BigInt(Math.ceil(75 * 1.5) + Math.ceil(4925 * 7.5)));

    // Gemini image generateContent reserves all maxOutputTokens at imageOutputUsdPerMillion, so
    // missing candidatesTokenCount with known thoughtsTokenCount bills remaining tokens (32768 - 500 = 32268)
    // as potential image outputs and stays within the reserved ceiling.
    const imageMissingCandidatesWithThoughts = calculateImageAttemptCostMicroUsd({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      promptChars: prompt.length,
      promptBytes,
      imageSize: '1K',
      aspectRatio: '1:1',
      outputCount: 1,
      outcome: 'ok',
      googleUsageMetadata: {
        promptTokenCount: 60,
        thoughtsTokenCount: 500,
      },
    });
    expect(imageMissingCandidatesWithThoughts).toBe(
      BigInt(Math.ceil(60 * 0.5) + Math.ceil((32_768 - 500) * 60) + Math.ceil(500 * 3.0))
    );
    expect(imageMissingCandidatesWithThoughts).toBeLessThanOrEqual(
      estimateImageCallCeilingMicroUsd({
        provider: 'gemini',
        model: 'gemini-3.1-flash-image',
        imageSize: '1K',
        aspectRatio: '1:1',
        outputCount: 1,
        maxPromptTokens: promptBytes + IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD,
      })
    );

    // Partial usage with candidatesTokenCount present but thoughtsTokenCount and totalTokenCount
    // omitted conservatively bills remaining (maxOutputTokens - candidatesTokenCount) at textOutputUsdPerMillion.
    const imageMissingThoughtsWithoutTotal = calculateImageAttemptCostMicroUsd({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      promptChars: prompt.length,
      promptBytes,
      imageSize: '1K',
      aspectRatio: '1:1',
      outputCount: 1,
      outcome: 'ok',
      googleUsageMetadata: {
        promptTokenCount: 60,
        candidatesTokenCount: 1_120,
      },
    });
    expect(imageMissingThoughtsWithoutTotal).toBe(
      BigInt(Math.ceil(60 * 0.5) + Math.ceil(1_120 * 60) + Math.ceil((32_768 - 1_120) * 3.0))
    );
    expect(imageMissingThoughtsWithoutTotal).toBeLessThanOrEqual(
      estimateImageCallCeilingMicroUsd({
        provider: 'gemini',
        model: 'gemini-3.1-flash-image',
        maxPromptTokens: promptBytes + IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD,
      })
    );

    // Completely missing usageMetadata on Gemini generateContent image accounts full maxOutputTokens
    // at imageOutputUsdPerMillion plus UTF-8 byte input bound.
    const imageMissingAllUsage = calculateImageAttemptCostMicroUsd({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      promptChars: prompt.length,
      promptBytes,
      imageSize: '1K',
      aspectRatio: '1:1',
      outputCount: 1,
      outcome: 'ok',
    });
    expect(imageMissingAllUsage).toBe(
      estimateImageCallCeilingMicroUsd({
        provider: 'gemini',
        model: 'gemini-3.1-flash-image',
        maxPromptTokens: promptBytes + IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD,
      })
    );

    // AC-2 regression: missing promptTokenCount and thoughtsTokenCount with known candidatesTokenCount
    // and totalTokenCount must never subtract an unmeasured prompt upper bound from totalTokenCount
    // (which would mask missing thoughts under cheaper input rates).
    const longPrompt = 'Молоко '.repeat(200);
    const longPromptBytes = Buffer.byteLength(longPrompt, 'utf8');
    const imageMaxPromptTokens = longPromptBytes + IMAGE_PROMPT_FRAMING_TOKEN_OVERHEAD;
    const imageFullConsistentCost = calculateImageAttemptCostMicroUsd({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      promptChars: longPrompt.length,
      promptBytes: longPromptBytes,
      imageSize: '1K',
      aspectRatio: '1:1',
      outputCount: 1,
      outcome: 'ok',
      googleUsageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 1_120,
        thoughtsTokenCount: 1_000,
        totalTokenCount: 2_320,
      },
    });
    const imagePartialMissingPromptAndThoughts = calculateImageAttemptCostMicroUsd({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image',
      promptChars: longPrompt.length,
      promptBytes: longPromptBytes,
      imageSize: '1K',
      aspectRatio: '1:1',
      outputCount: 1,
      outcome: 'ok',
      googleUsageMetadata: {
        candidatesTokenCount: 1_120,
        totalTokenCount: 2_320,
      },
    });
    expect(imagePartialMissingPromptAndThoughts).toBeGreaterThanOrEqual(imageFullConsistentCost);
    expect(imagePartialMissingPromptAndThoughts).toBeLessThanOrEqual(
      estimateImageCallCeilingMicroUsd({
        provider: 'gemini',
        model: 'gemini-3.1-flash-image',
        maxPromptTokens: imageMaxPromptTokens,
      })
    );

    // Analogous text estimator regressions:
    // (a) missing promptTokenCount & thoughtsTokenCount with known candidatesTokenCount & totalTokenCount
    const textFullConsistentCost = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: longPrompt.length,
      promptBytes: longPromptBytes,
      outcome: 'ok',
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 1_200,
        totalTokenCount: 1_500,
      },
    });
    const textPartialMissingPromptAndThoughts = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: longPrompt.length,
      promptBytes: longPromptBytes,
      outcome: 'ok',
      usageMetadata: {
        candidatesTokenCount: 100,
        totalTokenCount: 1_500,
      },
    });
    expect(textPartialMissingPromptAndThoughts).toBeGreaterThanOrEqual(textFullConsistentCost);
    expect(textPartialMissingPromptAndThoughts).toBeLessThanOrEqual(
      estimateTextAttemptCeilingMicroUsd(
        'gemini-3.8-flash',
        longPromptBytes + TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD
      )
    );

    // (b) missing thoughtsTokenCount & totalTokenCount with known candidatesTokenCount
    const textMissingThoughtsWithoutTotal = calculateTextAttemptCostMicroUsd({
      model: 'gemini-3.8-flash',
      promptChars: longPrompt.length,
      promptBytes: longPromptBytes,
      outcome: 'ok',
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 100,
      },
    });
    expect(textMissingThoughtsWithoutTotal).toBeGreaterThanOrEqual(textFullConsistentCost);
    expect(textMissingThoughtsWithoutTotal).toBeLessThanOrEqual(
      estimateTextAttemptCeilingMicroUsd(
        'gemini-3.8-flash',
        longPromptBytes + TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD
      )
    );
  });

  it('fails closed before DB reservation or SDK call for all unbounded OpenAI image configurations', async () => {
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '10.00');
    vi.stubEnv('AI_PROVIDER', 'gpt-image');

    for (const model of [undefined, ...UNBOUNDED_OPENAI_IMAGE_MODELS]) {
      if (model === undefined) {
        delete process.env.OPENAI_IMAGE_MODEL;
      } else {
        vi.stubEnv('OPENAI_IMAGE_MODEL', model);
      }

      const ruRes = await runImageAiCall({ id: 'admin-1', role: 'ADMIN' }, 'ru', () =>
        generateEmojiImage({ productName: 'Milk' })
      );
      expect(ruRes).toBeInstanceOf(Response);
      expect((ruRes as Response).status).toBe(503);
      expect(await (ruRes as Response).json()).toEqual({
        error: 'AI временно недоступен. Попробуйте позже.',
      });

      const enRes = await runImageAiCall({ id: 'admin-1', role: 'ADMIN' }, 'en', () =>
        generateEmojiImage({ productName: 'Milk' })
      );
      expect(enRes).toBeInstanceOf(Response);
      expect((enRes as Response).status).toBe(503);
      expect(await (enRes as Response).json()).toEqual({
        error: 'AI is temporarily unavailable. Please try again later.',
      });

      expect(() =>
        estimateImageCallCeilingMicroUsd({
          provider: 'gpt-image',
          model: model ?? 'gpt-image-2.5-flare',
        })
      ).toThrow(AiCostUnboundedError);
    }

    expect(dbState.monthlyCalls).toHaveLength(0);
    expect(dbState.rows.size).toBe(0);
    expect(dbState.sdkImageCalls).toHaveLength(0);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain('unbounded_configuration');
    expect(logged).not.toContain('gpt-image-2.5-sunburst');
  });

  it('releases full reservation ($0 spent) when Gemini image provider rejects with missing key', async () => {
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '2.50');
    delete process.env.GOOGLE_GENAI_API_KEY;

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
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 0,
          totalTokenCount: 200,
        },
      };
    });

    await runTextAiCall({ id: 'u1', role: 'USER' }, 'en', () =>
      generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Milk' })
    );

    expect(dbState.rows.get('2026-11-01T00:00:00.000Z')).toEqual({
      reservedMicroUsd: ZERO,
      spentMicroUsd: BigInt(900), // gemini-3.8-flash standard: 100*1.5 + 100*7.5
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
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 0,
          totalTokenCount: 200,
        },
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

    // After reconciliation, unused reserve is freed (only 2 * 900 = 1800 micro-USD spent).
    const nextOutcome = await runTextAiCall({ id: 'user-next', role: 'USER' }, 'en', () =>
      generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Bread' })
    );
    expect(nextOutcome).not.toBeInstanceOf(Response);
  });

  it('rejects text prompt exceeding reserved maxPromptTokens before SDK call and proves smart/bulk prompt estimators upper-bound actual prompts', async () => {
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '1.00');
    await expect(
      runTextAiCall(
        { id: 'u1', role: 'USER' },
        'en',
        () => generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Молоко '.repeat(500) }),
        { maxPromptTokens: 100 }
      )
    ).rejects.toThrow(/reserved monthly budget bound/);
    expect(dbState.sdkTextCalls).toHaveLength(0);

    const categories = Array.from({ length: 20 }, (_, i) => ({
      id: `cat-${i}`,
      name: `Категория ${i} Молочные продукты и напитки`,
      nameEn: `Category ${i} Dairy and Drinks`,
    }));
    const smartPrompt = buildSmartProductPrompt({
      productName: 'Ж'.repeat(120),
      categoryId: 'a'.repeat(64),
      categories,
    });
    expect(
      estimateSmartProductPromptTokens({
        productName: 'Ж'.repeat(120),
        categoryId: 'a'.repeat(64),
        categories,
      })
    ).toBeGreaterThanOrEqual(
      promptTokenUpperBound(smartPrompt, TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD)
    );

    const productNames = Array.from({ length: 50 }, () => 'Я'.repeat(40));
    const bulkPrompt = buildBulkProductsPrompt({ productNames, categories });
    expect(estimateBulkProductsPromptTokens({ productNames, categories })).toBeGreaterThanOrEqual(
      promptTokenUpperBound(bulkPrompt, TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD)
    );

    const catalog = Array.from({ length: 40 }, (_, i) => ({
      id: `prod-${i}`,
      name: `Товар ${i} Молочный`,
      nameEn: `Product ${i} Dairy`,
      categoryName: `Категория ${i % 20}`,
    }));
    const listText = 'Молоко 2л\nХлеб белый\nЯйца 10 шт';
    const listPrompt = buildShoppingListPrompt({ text: listText, categories, catalog });
    expect(
      estimateShoppingListPromptTokens({ text: listText, categories, catalog })
    ).toBeGreaterThanOrEqual(promptTokenUpperBound(listPrompt, TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD));
  });

  it('reconciles full actual spend and fails closed with MonthlyBudgetAccountingError when mocked Gemini image provider emits missing, partial, multi-image, or overspend usage', async () => {
    const validPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fake-png-bytes'),
    ]).toString('base64');
    const monthKey = startOfUtcMonth(new Date()).toISOString();
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '10.00');

    // 1. Multi-image response (3 images = 3360 tokens + 200 thoughts) stays within 32768 * $60/1M ceiling.
    dbState.sdkImageBehavior.mockResolvedValueOnce({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: validPng } },
              { inlineData: { mimeType: 'image/png', data: validPng } },
              { inlineData: { mimeType: 'image/png', data: validPng } },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 80,
        candidatesTokenCount: 3_360,
        thoughtsTokenCount: 200,
        totalTokenCount: 3_640,
      },
    });
    await runImageAiCall({ id: 'admin-1', role: 'ADMIN' }, 'en', () =>
      generateEmojiImage({ productName: 'Milk' })
    );
    const expectedMultiImageCost = BigInt(
      Math.ceil(80 * 0.5) + Math.ceil(3_360 * 60) + Math.ceil(200 * 3.0)
    );
    expect(dbState.rows.get(monthKey)).toEqual({
      reservedMicroUsd: ZERO,
      spentMicroUsd: expectedMultiImageCost,
    });

    // 2. Completely missing usageMetadata on ok response records full maxOutputTokens ceiling (not 1 image).
    dbState.rows.clear();
    dbState.sdkImageBehavior.mockResolvedValueOnce({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: validPng } }] },
        },
      ],
    });
    const outMissing = await runImageAiCall({ id: 'admin-1', role: 'ADMIN' }, 'en', () =>
      generateEmojiImage({ productName: 'Milk' })
    );
    expect(outMissing).toMatchObject({ model: 'gemini-3.1-flash-image' });
    const rowAfterMissing = dbState.rows.get(monthKey)!;
    expect(rowAfterMissing.reservedMicroUsd).toBe(ZERO);
    expect(rowAfterMissing.spentMicroUsd).toBeGreaterThan(BigInt(32_768 * 60));

    // 3. Overspend reported by mocked usageMetadata: records full actual spend, releases reserve, then fails closed.
    dbState.rows.clear();
    dbState.sdkImageBehavior.mockResolvedValueOnce({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: validPng } }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 35_000, // exceeds 32768 maxOutputTokens ceiling
        thoughtsTokenCount: 200,
        totalTokenCount: 35_300,
      },
    });
    await expect(
      runImageAiCall({ id: 'admin-1', role: 'ADMIN' }, 'en', () =>
        generateEmojiImage({ productName: 'Milk' })
      )
    ).rejects.toMatchObject({
      name: 'MonthlyBudgetAccountingError',
      reason: 'overspend_above_ceiling',
    });
    const expectedOverspend = BigInt(
      Math.ceil(100 * 0.5) + Math.ceil(35_000 * 60) + Math.ceil(200 * 3.0)
    );
    expect(dbState.rows.get(monthKey)).toEqual({
      reservedMicroUsd: ZERO,
      spentMicroUsd: expectedOverspend,
    });

    // 4. Overspend without usageMetadata (e.g. 30 final image parts emitted -> 30 * 1120 = 33600 > 32768)
    // accounts full 33600 * $60/1M and fails closed.
    dbState.rows.clear();
    dbState.sdkImageBehavior.mockResolvedValueOnce({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: Array.from({ length: 30 }, () => ({
              inlineData: { mimeType: 'image/png', data: validPng },
            })),
          },
        },
      ],
    });
    await expect(
      runImageAiCall({ id: 'admin-1', role: 'ADMIN' }, 'en', () =>
        generateEmojiImage({ productName: 'Milk' })
      )
    ).rejects.toMatchObject({
      name: 'MonthlyBudgetAccountingError',
      reason: 'overspend_above_ceiling',
    });
    const rowAfterMultiPartOverspend = dbState.rows.get(monthKey)!;
    expect(rowAfterMultiPartOverspend.reservedMicroUsd).toBe(ZERO);
    expect(rowAfterMultiPartOverspend.spentMicroUsd).toBeGreaterThan(BigInt(33_600 * 60));
  });

  it('rejects unproven/unknown image bounds (model, size, quality, imageSize, outputCount) before DB reservation or SDK call', async () => {
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '10.00');
    for (const unprovenModel of [
      'gemini-3.1-flash-lite-image',
      'gemini-2.5-flash-image',
      'gemini-2.5-flash-image-preview',
      'gemini-3-pro-image',
      'imagen-4.0-generate-001',
      'imagen-4.0-fast-generate-001',
      'imagen-4.0-ultra-generate-001',
      'imagen-5.0-generate-preview',
    ]) {
      vi.stubEnv('GOOGLE_IMAGE_MODEL', unprovenModel);
      await expect(
        runImageAiCall({ id: 'admin-1', role: 'ADMIN' }, 'en', () =>
          generateEmojiImage({ productName: 'Milk' })
        )
      ).rejects.toThrow(/GOOGLE_IMAGE_MODEL/);
    }
    delete process.env.GOOGLE_IMAGE_MODEL;
    vi.stubEnv('IMAGEN_MODEL', 'gemini-3.1-flash-lite-image');
    await expect(
      runImageAiCall({ id: 'admin-1', role: 'ADMIN' }, 'en', () =>
        generateEmojiImage({ productName: 'Milk' })
      )
    ).rejects.toThrow(/IMAGEN_MODEL/);
    delete process.env.IMAGEN_MODEL;

    expect(dbState.monthlyCalls).toHaveLength(0);
    expect(dbState.sdkImageCalls).toHaveLength(0);

    expect(() =>
      estimateImageCallCeilingMicroUsd({
        provider: 'gpt-image',
        model: 'gpt-image-2.5-flare',
        size: 'auto',
        quality: 'medium',
      })
    ).toThrow(AiCostUnboundedError);

    expect(() =>
      estimateImageCallCeilingMicroUsd({
        provider: 'gpt-image',
        model: 'gpt-image-2.5-flare',
        size: '1024x1024',
        quality: 'ultra',
      })
    ).toThrow(AiCostUnboundedError);

    expect(() =>
      estimateImageCallCeilingMicroUsd({
        provider: 'gemini',
        model: 'gemini-3.1-flash-image',
        imageSize: '8K',
      })
    ).toThrow(/Unsupported imageSize/);

    expect(() =>
      estimateImageCallCeilingMicroUsd({
        provider: 'gemini',
        model: 'gemini-3.1-flash-image',
        outputCount: 2,
      })
    ).toThrow(/Invalid image output count/);

    // Verify proven default gemini-3.1-flash-image reserves maxOutputTokens (32,768) + prompt bound.
    expect(
      estimateImageCallCeilingMicroUsd({
        provider: 'gemini',
        model: 'gemini-3.1-flash-image',
        maxPromptTokens: 100,
      })
    ).toBe(BigInt(Math.ceil(100 * 0.5) + Math.ceil(32_768 * 60)));

    // calculateTextOperationCostMicroUsd when succeeded without recorded attempts uses ceilingMicroUsd
    expect(
      calculateTextOperationCostMicroUsd({
        attempts: [],
        succeeded: true,
        ceilingMicroUsd: BigInt(12_345),
      })
    ).toBe(BigInt(12_345));
    expect(MAX_TEXT_OUTPUT_TOKENS).toBe(4_096);
  });

  it('covers CLI text calls via runMonthlyBudgetedTextAiCall using shared monthly cap and reconciliation', async () => {
    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '0');
    await expect(
      runMonthlyBudgetedTextAiCall({ prompt: 'Import milk' }, () =>
        generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Import milk' })
      )
    ).rejects.toBeInstanceOf(MonthlyBudgetBlockedError);
    expect(dbState.sdkTextCalls).toHaveLength(0);

    vi.stubEnv(AI_MONTHLY_BUDGET_USD_ENV, '1.00');
    dbState.sdkTextBehavior.mockResolvedValueOnce({
      text: '[]',
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 0,
        totalTokenCount: 300,
      },
    });
    const out = await runMonthlyBudgetedTextAiCall({ prompt: 'Import milk' }, () =>
      generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Import milk' })
    );
    expect(out).toEqual({ text: '[]', model: 'gemini-3.8-flash' });
    const monthKey = startOfUtcMonth(new Date()).toISOString();
    expect(dbState.rows.get(monthKey)).toEqual({
      reservedMicroUsd: ZERO,
      spentMicroUsd: BigInt(200 * 1.5 + 100 * 7.5),
    });

    // CLI propagates reconciliation failure
    dbState.failReconcile = true;
    dbState.sdkTextBehavior.mockResolvedValueOnce({
      text: '[]',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    });
    await expect(
      runMonthlyBudgetedTextAiCall({ prompt: 'Import milk' }, () =>
        generateGoogleText({ apiKey: 'synthetic-google-key', prompt: 'Import milk' })
      )
    ).rejects.toBeInstanceOf(MonthlyBudgetAccountingError);
  });
});
