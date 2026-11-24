// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  it.each([500, 429, 408, 503])(
    'OpenAI images.generate performs exactly one fetch on HTTP %i (maxRetries: 0)',
    async (status) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: 'synthetic upstream failure', code: 'server_error' },
            }),
            { status, headers: { 'Content-Type': 'application/json' } }
          )
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        generateWithOpenAI({
          productName: 'Milk',
          description: PRIVATE_PROMPT,
          apiKey: 'synthetic-openai-key',
        })
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('OpenAI images.generate performs exactly one fetch on network connection error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateWithOpenAI({
        productName: 'Milk',
        apiKey: 'synthetic-openai-key',
      })
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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
    }
  );

  it('Google generateImages (Imagen) adapter performs exactly one fetch on HTTP 500', async () => {
    vi.stubEnv('GOOGLE_IMAGE_MODEL', 'imagen-4.0-generate-001');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: 'fail' } }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
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
  });
});
