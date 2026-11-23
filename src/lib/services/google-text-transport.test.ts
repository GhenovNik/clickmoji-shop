// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateGoogleText } from './google-text-generation';
import { GoogleTextUnavailableError } from './text-ai-errors';

// Exercise the installed SDK, not an SDK double: request-level retryOptions alone must not give
// false assurance about transport attempts or erase the structured status needed by our policy.
const PRIMARY = 'gemini-3.8-flash';
const FALLBACK = 'gemini-2.5-flash';
const PRIVATE = 'synthetic-private-do-not-log';
const successfulReply = () =>
  new Response(
    JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
const unavailableReply = (status: number) =>
  new Response(
    JSON.stringify({
      error: {
        code: status,
        status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE',
        message: PRIVATE,
      },
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
const run = () => generateGoogleText({ apiKey: 'synthetic-sdk-transport-key', prompt: PRIVATE });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('GOOGLE_TEXT_MODEL', PRIMARY);
  vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', undefined);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('real Google SDK transport retry boundary (no network)', () => {
  it.each([503, 429])(
    'caps HTTP %i at three actual fetches and returns safe 503',
    async (status) => {
      const fetch = vi.fn(async () => unavailableReply(status));
      vi.stubGlobal('fetch', fetch);
      const pending = expect(run()).rejects.toBeInstanceOf(GoogleTextUnavailableError);
      await vi.runAllTimersAsync();
      await pending;
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(console.info).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(PRIVATE);
    }
  );

  it('uses fallback at transport attempt three and returns the actual successful model', async () => {
    vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', FALLBACK);
    let attempts = 0;
    const fetch = vi.fn(async () => (++attempts < 3 ? unavailableReply(503) : successfulReply()));
    vi.stubGlobal('fetch', fetch);
    const pending = run();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ text: 'ok', model: FALLBACK });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      expect.stringContaining(`/models/${PRIMARY}:generateContent`),
      expect.stringContaining(`/models/${PRIMARY}:generateContent`),
      expect.stringContaining(`/models/${FALLBACK}:generateContent`),
    ]);
  });

  it.each([400, 401, 403, 404, 408, 422])('does not retry an actual HTTP %i', async (status) => {
    vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', FALLBACK);
    const fetch = vi.fn(async () => unavailableReply(status));
    vi.stubGlobal('fetch', fetch);
    const pending = expect(run()).rejects.toMatchObject({ status });
    await vi.runAllTimersAsync();
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains the network timeout cause and bounds actual transport calls', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    });
    vi.stubGlobal('fetch', fetch);
    const pending = expect(run()).rejects.toBeInstanceOf(GoogleTextUnavailableError);
    await vi.runAllTimersAsync();
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
