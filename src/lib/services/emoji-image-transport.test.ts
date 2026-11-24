// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCostUnboundedError } from './emoji-errors';
import { generateWithGoogleImage, generateWithOpenAI } from './emoji-image-adapters';

const PRIVATE_PROMPT = 'synthetic-private-prompt-do-not-log';

beforeEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.GOOGLE_IMAGE_MODEL;
  delete process.env.IMAGEN_MODEL;
  delete process.env.OPENAI_IMAGE_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('real SDK image transport single-attempt boundary (no network)', () => {
  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5'])(
    'OpenAI images.generate performs zero fetches and fails closed for unbounded model %s',
    async (model) => {
      vi.stubEnv('OPENAI_IMAGE_MODEL', model);
      const fetchMock = vi.fn(async () => {
        throw new Error('fetch must not be called for unbounded OpenAI model');
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        generateWithOpenAI({
          productName: 'Milk',
          description: PRIVATE_PROMPT,
          apiKey: 'synthetic-openai-key',
        })
      ).rejects.toBeInstanceOf(AiCostUnboundedError);

      expect(fetchMock).toHaveBeenCalledTimes(0);
    }
  );

  it.each([500, 429, 503])(
    'Google generateContent image adapter performs exactly one fetch on HTTP %i',
    async (status) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: status, status: 'UNAVAILABLE', message: 'fail' } }),
            { status, headers: { 'Content-Type': 'application/json' } }
          )
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        generateWithGoogleImage({
          productName: 'Milk',
          apiKey: 'synthetic-google-key',
        })
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body.generationConfig).toMatchObject({
        candidateCount: 1,
        maxOutputTokens: 32_768,
      });
    }
  );

  it.each(['imagen-4.0-generate-001', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'])(
    'Google adapter performs zero fetches and fails closed for unproven/retired model %s',
    async (model) => {
      vi.stubEnv('GOOGLE_IMAGE_MODEL', model);
      const fetchMock = vi.fn(async () => {
        throw new Error('fetch must not be called for unproven/retired model');
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        generateWithGoogleImage({
          productName: 'Milk',
          apiKey: 'synthetic-google-key',
        })
      ).rejects.toThrow(/GOOGLE_IMAGE_MODEL/);

      expect(fetchMock).toHaveBeenCalledTimes(0);
    }
  );
});
