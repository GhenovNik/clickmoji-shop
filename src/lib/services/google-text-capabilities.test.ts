import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateGoogleText } from './google-text-generation';
import { GoogleTextModelConfigurationError } from './google-text-model';

const sdk = vi.hoisted(() => ({ constructor: vi.fn(), generate: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor() {
      sdk.constructor();
    }
    models = { generateContent: sdk.generate };
  },
}));

const PRIMARY = 'gemini-3.8-flash';
// Deliberately exact IDs, not a gemini-* shape or a denylist of special suffixes.
const TEXT_MODELS = [PRIMARY, 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
const UNSUPPORTED = [
  'gemini-embedding-001',
  'gemini-embedding-2',
  'gemini-3.8-flash-tts',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
  'gemini-3.1-flash-image',
  'gemini-2.5-flash-image-preview',
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-09-2025',
  'gemini-3.5-transcribe',
  'gemini-omni-1.1-flash',
  'gemini-99-flash',
  'gemini-3.8-flash-unverified',
];
const ENVS = ['GOOGLE_TEXT_MODEL', 'GOOGLE_TEXT_MODEL_FALLBACK'] as const;
const run = () =>
  generateGoogleText({ apiKey: 'synthetic-capability-test-key', prompt: 'private-test-text' });
const unavailable = () => Object.assign(new Error('synthetic high demand'), { status: 503 });

async function settle() {
  const pending = run().then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await vi.runAllTimersAsync();
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('GOOGLE_TEXT_MODEL', undefined);
  vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  sdk.constructor.mockClear();
  sdk.generate.mockReset().mockResolvedValue({ text: 'ok' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

for (const env of ENVS) {
  describe(`${env} capability refusal before SDK construction`, () => {
    it.each(UNSUPPORTED)(
      'rejects %s instead of treating its name as text capability',
      async (model) => {
        vi.stubEnv(env, model);
        await expect(run()).rejects.toBeInstanceOf(GoogleTextModelConfigurationError);
        expect(sdk.constructor).not.toHaveBeenCalled();
        expect(sdk.generate).not.toHaveBeenCalled();
      }
    );

    it('logs the rejected setting and a useful capability diagnostic without raw values or keys', async () => {
      const privateValue = 'synthetic-private-config-value-do-not-log';
      vi.stubEnv(env, privateValue);
      await expect(run()).rejects.toBeInstanceOf(GoogleTextModelConfigurationError);
      expect(sdk.constructor).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
      expect(logged).toContain(env);
      expect(logged).toContain('UNSUPPORTED_TEXT_MODEL');
      expect(logged).toContain('generateContent');
      expect(logged).not.toContain(privateValue);
      expect(logged).not.toContain('synthetic-capability-test-key');
      expect(logged).not.toContain('private-test-text');
    });
  });
}

describe('explicit text model choices and unchanged retry/default behavior', () => {
  it.each(TEXT_MODELS)('uses an explicitly supported primary %s', async (model) => {
    vi.stubEnv('GOOGLE_TEXT_MODEL', `  ${model}\n`);
    expect(await run()).toEqual({ text: 'ok', model });
    expect(sdk.generate).toHaveBeenCalledTimes(1);
    expect(sdk.generate.mock.calls[0][0]).toMatchObject({ model });
  });

  it.each([undefined, '', '   '])(
    'without fallback env (%s), keeps the unchanged default on all attempts',
    async (fallback) => {
      vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', fallback);
      sdk.generate.mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable());
      expect(await settle()).toEqual({ value: { text: 'ok', model: PRIMARY } });
      expect(sdk.generate.mock.calls.map(([params]) => params.model)).toEqual([
        PRIMARY,
        PRIMARY,
        PRIMARY,
      ]);
    }
  );

  it.each(['gemini-3.5-flash-lite', 'gemini-2.5-flash'])(
    'uses explicitly configured %s only on attempt three',
    async (fallback) => {
      vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', fallback);
      sdk.generate.mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable());
      expect(await settle()).toEqual({ value: { text: 'ok', model: fallback } });
      expect(sdk.generate.mock.calls.map(([params]) => params.model)).toEqual([
        PRIMARY,
        PRIMARY,
        fallback,
      ]);
    }
  );

  it.each([1, 2])(
    'does not call a configured fallback when primary succeeds on attempt %i',
    async (attempt) => {
      vi.stubEnv('GOOGLE_TEXT_MODEL_FALLBACK', 'gemini-3.5-flash-lite');
      if (attempt === 2) sdk.generate.mockRejectedValueOnce(unavailable());
      expect(await settle()).toEqual({ value: { text: 'ok', model: PRIMARY } });
      expect(sdk.generate.mock.calls.map(([params]) => params.model)).toEqual(
        Array(attempt).fill(PRIMARY)
      );
    }
  );
});
