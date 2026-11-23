import { ApiError } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  generate: vi.fn<(params: Record<string, unknown>) => Promise<{ text: string }>>(),
  calls: [] as Array<{
    params: Record<string, unknown>;
    clientOptions: Record<string, unknown>;
    at: number;
  }>,
}));

vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class GoogleGenAIDouble {
    constructor(private readonly options: Record<string, unknown>) {}

    models = {
      generateContent: (params: Record<string, unknown>) => {
        sdk.calls.push({ params, clientOptions: this.options, at: Date.now() });
        return sdk.generate(params);
      },
    };
  },
}));

const { analyzeSmartProduct, processProductBatch, parseShoppingListText } =
  await import('./ai-products');

const PRIMARY = 'gemini-3.8-flash';
const FALLBACK = 'gemini-2.5-flash';
// Deliberately synthetic markers: never send a real API key or private prompt to the SDK.
const API_KEY = 'synthetic-key-do-not-log';
const PRIVATE_PROMPT = 'private-shopping-text-do-not-log';
const PRIVATE_ERROR = 'provider-private-details-do-not-log';
const CATEGORIES = [{ id: 'dairy', name: 'Молочное', nameEn: 'Dairy' }];
const PRODUCT = { nameRu: 'Молоко', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' };
const SMART_PRODUCT = { ...PRODUCT, needsCustomEmoji: false };

const SERVICES = [
  {
    name: 'analyzeSmartProduct',
    response: JSON.stringify(SMART_PRODUCT),
    expected: { result: SMART_PRODUCT },
    run: () =>
      analyzeSmartProduct({ apiKey: API_KEY, productName: PRIVATE_PROMPT, categories: CATEGORIES }),
  },
  {
    name: 'processProductBatch',
    response: JSON.stringify([PRODUCT]),
    expected: { products: [PRODUCT] },
    run: () =>
      processProductBatch({
        apiKey: API_KEY,
        productNames: [PRIVATE_PROMPT],
        categories: CATEGORIES,
      }),
  },
  {
    name: 'parseShoppingListText',
    response: JSON.stringify([PRODUCT]),
    expected: { products: [PRODUCT], invalid: [] },
    run: () =>
      parseShoppingListText({ apiKey: API_KEY, text: PRIVATE_PROMPT, categories: CATEGORIES }),
  },
];

const unavailable = () =>
  new ApiError({
    status: 503,
    message: JSON.stringify({
      error: { code: 503, status: 'UNAVAILABLE', message: PRIVATE_ERROR },
    }),
  });

// Attach both handlers before advancing any clocks, including in baseline RED runs.
function observe(promise: Promise<unknown>) {
  let outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
  void promise.then(
    (value) => {
      outcome = { ok: true, value };
    },
    (error: unknown) => {
      outcome = { ok: false, error };
    }
  );
  return () => outcome;
}

async function finish(promise: Promise<unknown>) {
  const outcome = observe(promise);
  await vi.runAllTimersAsync();
  const result = outcome();
  expect(result, 'operation must settle without real sleeps').toBeDefined();
  return result!;
}

function assertSafeUnavailable(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  // Public contract: a typed, sanitized service error usable by route status mapping.
  // Do not couple tests to a new module or a particular exported class name.
  expect(error).toMatchObject({ status: 503 });
  expect((error as Error).name).not.toBe('Error');
  expect((error as Error).name).not.toBe('ApiError');
  const publicError = `${String(error)} ${JSON.stringify(error)}`;
  expect(publicError).not.toContain(PRIVATE_ERROR);
  expect(publicError).not.toContain(PRIVATE_PROMPT);
  expect(publicError).not.toContain(API_KEY);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.stubEnv('GOOGLE_TEXT_MODEL', PRIMARY);
  vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', undefined);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sdk.calls.length = 0;
  sdk.generate.mockReset();
  sdk.generate.mockResolvedValue({ text: SERVICES[0].response });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

for (const service of SERVICES) {
  describe(`${service.name}: shared text retry contract`, () => {
    it('recovers after a 503 using the primary model again and preserves parsed output', async () => {
      sdk.generate
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValue({ text: service.response });

      const outcome = await finish(service.run());

      expect(outcome).toMatchObject({ ok: true, value: { ...service.expected, model: PRIMARY } });
      expect(sdk.calls.map(({ params }) => params.model)).toEqual([PRIMARY, PRIMARY]);
    });

    it('uses the optional fallback only on the final third attempt and reports its actual model', async () => {
      vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', FALLBACK);
      sdk.generate
        .mockRejectedValueOnce(unavailable())
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValue({ text: service.response });

      const outcome = await finish(service.run());

      expect(sdk.calls.map(({ params }) => params.model)).toEqual([PRIMARY, PRIMARY, FALLBACK]);
      expect(outcome).toMatchObject({ ok: true, value: { ...service.expected, model: FALLBACK } });
    });

    it('exhausts at three total SDK attempts and rejects with a sanitized typed status-503 error', async () => {
      vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', FALLBACK);
      sdk.generate.mockRejectedValue(unavailable());

      const outcome = await finish(service.run());

      expect(sdk.calls.map(({ params }) => params.model)).toEqual([PRIMARY, PRIMARY, FALLBACK]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) assertSafeUnavailable(outcome.error);
    });

    it('does not retry a non-429 400 response even with a fallback configured', async () => {
      vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', FALLBACK);
      sdk.generate.mockRejectedValue(new ApiError({ status: 400, message: 'Invalid argument' }));

      const outcome = await finish(service.run());

      expect(outcome.ok).toBe(false);
      expect(sdk.calls).toHaveLength(1);
    });

    it('bounds SDK transport retries and configures a per-attempt timeout and abort signal', async () => {
      sdk.generate.mockResolvedValue({ text: service.response });
      const outcome = await finish(service.run());

      expect(outcome.ok).toBe(true);
      expect(sdk.calls).toHaveLength(1);
      const call = sdk.calls[0];
      const config = call.params.config as Record<string, unknown>;
      // HTTP options may be set on the SDK client or overridden on this request.
      const httpOptions = {
        ...(call.clientOptions.httpOptions as Record<string, unknown> | undefined),
        ...(config.httpOptions as Record<string, unknown> | undefined),
      };
      expect(config).toMatchObject({ responseMimeType: 'application/json' });
      expect(httpOptions).toMatchObject({ retryOptions: { attempts: 1 }, timeout: 8_000 });
      expect(config.abortSignal).toMatchObject({ aborted: false });
      expect(typeof (config.abortSignal as AbortSignal).addEventListener).toBe('function');
    });
  });
}

describe('transient error classification through the existing public API', () => {
  const retryableErrors: Array<[string, () => unknown]> = [
    ['HTTP status 503', () => ({ status: 503 })],
    ['HTTP status 429', () => ({ status: 429 })],
    ['numeric code 503', () => ({ code: 503 })],
    ['numeric code 429', () => ({ code: 429 })],
    ['canonical UNAVAILABLE code', () => ({ code: 'UNAVAILABLE' })],
    ['canonical RESOURCE_EXHAUSTED code', () => ({ code: 'RESOURCE_EXHAUSTED' })],
    ['canonical UNAVAILABLE status', () => ({ status: 'UNAVAILABLE' })],
    ['canonical RESOURCE_EXHAUSTED status', () => ({ status: 'RESOURCE_EXHAUSTED' })],
    ['nested Google error', () => ({ error: { code: 503, status: 'UNAVAILABLE' } })],
    ['nested cause', () => new Error('fetch failed', { cause: { code: 'ETIMEDOUT' } })],
    ['real Google ApiError with JSON message', unavailable],
    [
      'JSON message supplies the Google status when outer status is absent',
      () =>
        new Error(
          JSON.stringify({
            error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: PRIVATE_ERROR },
          })
        ),
    ],
    ['network ETIMEDOUT', () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })],
    ['TimeoutError', () => Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
    ['AbortError', () => Object.assign(new Error('aborted'), { name: 'AbortError' })],
  ];

  it.each(retryableErrors)('retries %s and succeeds', async (_name, makeError) => {
    sdk.generate.mockRejectedValueOnce(makeError());

    const outcome = await finish(SERVICES[0].run());

    expect(outcome).toMatchObject({ ok: true, value: { model: PRIMARY } });
    expect(sdk.calls).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 408, 422])('does not retry HTTP %i', async (status) => {
    vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', FALLBACK);
    sdk.generate.mockRejectedValue(new ApiError({ status, message: 'Request rejected' }));

    const outcome = await finish(SERVICES[0].run());

    expect(outcome.ok).toBe(false);
    expect(sdk.calls).toHaveLength(1);
  });

  it('does not retry an unknown failure or invent a fallback attempt', async () => {
    vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', FALLBACK);
    sdk.generate.mockRejectedValue(new Error('Unknown provider problem'));

    const outcome = await finish(SERVICES[0].run());

    expect(outcome.ok).toBe(false);
    expect(sdk.calls).toHaveLength(1);
  });
});

describe('retry limits, clocks and safe observability', () => {
  it.each([undefined, '', '   ', PRIMARY])(
    'keeps all three attempts on primary when fallback is %s',
    async (fallback) => {
      vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', fallback);
      sdk.generate.mockRejectedValue(unavailable());

      const outcome = await finish(SERVICES[0].run());

      expect(outcome.ok).toBe(false);
      expect(sdk.calls.map(({ params }) => params.model)).toEqual([PRIMARY, PRIMARY, PRIMARY]);
    }
  );

  it.each([0, 0.5, 0.999999])(
    'uses exponential jitter windows at random=%s, without an extra sleep after exhaustion',
    async (random) => {
      vi.mocked(Math.random).mockReturnValue(random);
      sdk.generate.mockRejectedValue(unavailable());
      const started = Date.now();

      const outcome = await finish(SERVICES[0].run());

      expect(outcome.ok).toBe(false);
      expect(sdk.calls).toHaveLength(3);
      const firstDelay = sdk.calls[1].at - sdk.calls[0].at;
      const secondDelay = sdk.calls[2].at - sdk.calls[1].at;
      expect(firstDelay).toBeGreaterThanOrEqual(500);
      expect(firstDelay).toBeLessThan(1_000);
      expect(secondDelay).toBeGreaterThanOrEqual(1_000);
      expect(secondDelay).toBeLessThan(2_000);
      expect(Date.now() - started).toBe(firstDelay + secondDelay);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('settles a hard-hung SDK within 30 seconds, aborting each attempt at 8 seconds', async () => {
    vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', FALLBACK);
    // Intentionally ignores abortSignal, so merely passing a timeout to the SDK is insufficient.
    sdk.generate.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const readOutcome = observe(SERVICES[0].run());
    let settledAt: number | undefined;
    // Observe settlement on fake time without ever awaiting the deliberately hung SDK promise.
    const settle = () => {
      if (readOutcome() && settledAt === undefined) settledAt = Date.now();
    };

    await vi.advanceTimersByTimeAsync(7_999);
    expect(sdk.calls).toHaveLength(1);
    expect(readOutcome()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const firstConfig = sdk.calls[0].params.config as { abortSignal?: AbortSignal };
    expect(firstConfig.abortSignal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(22_000);
    settle();
    const outcome = readOutcome();
    expect(
      outcome,
      '30-second total budget must bound even an SDK that never settles'
    ).toBeDefined();
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) assertSafeUnavailable(outcome.error);
    expect(settledAt! - started).toBeLessThanOrEqual(30_000);
    expect(sdk.calls.map(({ params }) => params.model)).toEqual([PRIMARY, PRIMARY, FALLBACK]);
    for (const call of sdk.calls) {
      expect((call.params.config as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(true);
    }
    const callsAtDeadline = sdk.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sdk.calls).toHaveLength(callsAtDeadline);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes one safe info line per attempt with code and attempt, never raw provider data', async () => {
    sdk.generate.mockRejectedValue(unavailable());

    await finish(SERVICES[0].run());

    expect(sdk.calls).toHaveLength(3);
    expect(console.info).toHaveBeenCalledTimes(3);
    for (const [index, args] of vi.mocked(console.info).mock.calls.entries()) {
      // Permit structured objects or a single formatted/JSON line; avoid a rigid logger schema.
      const line = args
        .map((arg: unknown) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' ');
      expect(line).toMatch(new RegExp(`attempt["'\\s:=]+${index + 1}\\b`, 'i'));
      expect(line).toMatch(/code["'\s:=]+(?:"|')?(?:503|UNAVAILABLE)\b/i);
      expect(line).not.toContain('\n');
      expect(args.some((arg: unknown) => arg instanceof Error)).toBe(false);
    }
    const output = JSON.stringify([
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]);
    expect(output).not.toContain(PRIVATE_ERROR);
    expect(output).not.toContain(PRIVATE_PROMPT);
    expect(output).not.toContain(API_KEY);
  });
});
