// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shared daily AI budget is covered by src/app/api/ai-daily-quota.test.ts.
vi.mock('@/lib/ai-quota', () => ({ enforceAiQuota: async () => null }));
import { NextResponse } from 'next/server';

const marker = 'synthetic-provider-marker-347';

type GuardDouble = { session: { user: { id: string; role: string } } } | Response;

const doubles = vi.hoisted(() => ({
  sdkCalls: [] as string[],
  generateEmojiImage: vi.fn(async () => {
    throw new Error('not configured');
  }),
  uploadEmojiImage: vi.fn(async () => {
    throw new Error('upload must not run');
  }),
  recordEmojiLibraryItem: vi.fn(async () => null),
  checkRateLimit: vi.fn(async () => ({
    allowed: true as boolean,
    remaining: 19,
    resetAt: 0,
  })),
  requireAdmin: vi.fn<() => Promise<GuardDouble>>(async () => {
    throw new Error('not configured');
  }),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateImages: async () => {
        doubles.sdkCalls.push('generateImages');
        return { generatedImages: [] };
      },
      generateContent: async () => {
        doubles.sdkCalls.push('generateContent');
        return { candidates: [] };
      },
    };
  },
}));

vi.mock('openai', () => ({
  default: class {
    images = {
      generate: async () => {
        doubles.sdkCalls.push('images.generate');
        return { data: [] };
      },
    };
  },
}));

vi.mock('uploadthing/server', () => ({
  UTApi: class {
    uploadFiles = async () => {
      doubles.sdkCalls.push('uploadFiles');
      throw new Error('upload must not run');
    };
  },
}));

vi.mock('@/lib/services/emoji-assets', () => ({
  generateEmojiImage: doubles.generateEmojiImage,
  uploadEmojiImage: doubles.uploadEmojiImage,
  uploadEmojiBase64Image: doubles.uploadEmojiImage,
  generateAndUploadEmojiAsset: doubles.uploadEmojiImage,
}));

vi.mock('@/lib/services/emoji-library', () => ({
  recordEmojiLibraryItem: doubles.recordEmojiLibraryItem,
}));

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: doubles.requireAdmin,
  requireUser: doubles.requireAdmin,
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: doubles.checkRateLimit };
});

const { POST } = await import('@/app/api/emoji/generate/route');
const { EmojiProviderUnavailableError } = await import('@/lib/services/emoji-errors');

function generateRequest(productName = 'Milk') {
  return new Request('http://localhost:3000/api/emoji/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productName }),
  });
}

beforeEach(() => {
  doubles.sdkCalls.length = 0;
  doubles.generateEmojiImage.mockReset();
  doubles.uploadEmojiImage.mockReset();
  doubles.recordEmojiLibraryItem.mockReset();
  doubles.checkRateLimit.mockReset();
  doubles.requireAdmin.mockReset();
  doubles.generateEmojiImage.mockRejectedValue(new Error(marker));
  doubles.uploadEmojiImage.mockRejectedValue(new Error('upload must not run'));
  doubles.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: 0 });
  doubles.requireAdmin.mockResolvedValue({ session: { user: { id: 'admin-1', role: 'ADMIN' } } });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AC-7 POST /api/emoji/generate error contract', () => {
  it('keeps the previous 500 response body when generation fails', async () => {
    const response = await POST(generateRequest());
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(bodyText)).toEqual({ error: 'Failed to generate emoji' });
    expect(bodyText).not.toContain(marker);
  });

  it('does not call the SDK or the service when the caller is not an admin', async () => {
    doubles.requireAdmin.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const response = await POST(generateRequest());

    expect(response.status).toBe(401);
    expect(doubles.generateEmojiImage).not.toHaveBeenCalled();
    expect(doubles.sdkCalls).toHaveLength(0);
  });

  it('does not call the SDK or the service when the rate limit is exhausted', async () => {
    doubles.checkRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const response = await POST(generateRequest());

    expect(response.status).toBe(429);
    expect(doubles.generateEmojiImage).not.toHaveBeenCalled();
    expect(doubles.sdkCalls).toHaveLength(0);
  });
});

describe('AC-16 an unavailable provider is reported as 503', () => {
  const unavailable = (reason: 'missing-key' | 'quota' | 'auth') =>
    new EmojiProviderUnavailableError({
      reason,
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite-image',
    });

  for (const reason of ['missing-key', 'quota', 'auth'] as const) {
    it(`returns the unavailable-provider body for reason ${reason}`, async () => {
      doubles.generateEmojiImage.mockRejectedValue(unavailable(reason));

      const response = await POST(generateRequest());
      const bodyText = await response.text();

      expect(response.status).toBe(503);
      expect(JSON.parse(bodyText)).toEqual({
        error:
          'AI image generation is unavailable right now (provider quota or API key). Pick a regular emoji instead.',
        code: 'image_provider_unavailable',
      });
      expect(bodyText).not.toContain(marker);
    });
  }

  it('keeps the previous 500 body for any other generation error', async () => {
    doubles.generateEmojiImage.mockRejectedValue(new Error(`${marker} ordinary failure`));

    const response = await POST(generateRequest());
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(bodyText)).toEqual({ error: 'Failed to generate emoji' });
    expect(bodyText).not.toContain(marker);
  });

  it('does not call the SDK when the provider is unavailable', async () => {
    doubles.generateEmojiImage.mockRejectedValue(unavailable('quota'));

    await POST(generateRequest());

    expect(doubles.sdkCalls).toHaveLength(0);
  });
});

describe('POST /api/emoji/generate keeps every paid picture', () => {
  it('stores the generated picture in the library at once and returns its URL', async () => {
    doubles.generateEmojiImage.mockResolvedValue({
      imageBuffer: Buffer.from('png'),
      provider: 'gemini',
      model: 'model',
      promptVersion: 'v',
      cacheKey: 'k',
    } as never);
    doubles.uploadEmojiImage.mockResolvedValue({
      imageUrl: 'https://utfs.io/f/generated.webp',
      fileName: 'ai-emoji-milk.webp',
    } as never);

    const response = await POST(
      new Request('http://localhost:3000/api/emoji/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productName: 'Milk', name: 'Молоко', nameEn: 'Milk' }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imageUrl: 'https://utfs.io/f/generated.webp' });
    expect(doubles.uploadEmojiImage).toHaveBeenCalledTimes(1);
    expect(doubles.recordEmojiLibraryItem).toHaveBeenCalledWith({
      imageUrl: 'https://utfs.io/f/generated.webp',
      name: 'Молоко',
      nameEn: 'Milk',
      source: 'generated',
    });
  });

  it('says so when the library cannot be written, after one retry', async () => {
    doubles.generateEmojiImage.mockResolvedValue({
      imageBuffer: Buffer.from('png'),
      provider: 'gemini',
      model: 'model',
      promptVersion: 'v',
      cacheKey: 'k',
    } as never);
    doubles.uploadEmojiImage.mockResolvedValue({
      imageUrl: 'https://utfs.io/f/generated.webp',
      fileName: 'ai-emoji-milk.webp',
    } as never);
    doubles.recordEmojiLibraryItem.mockResolvedValue(null);

    const response = await POST(generateRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      imageUrl: 'https://utfs.io/f/generated.webp',
      libraryRecorded: false,
    });
    expect(body.message).not.toContain('saved to the emoji library.');
    expect(doubles.recordEmojiLibraryItem).toHaveBeenCalledTimes(2);
  });
});

describe('generate errors follow the request language', () => {
  function request(cookie: string) {
    return new Request('http://localhost:3000/api/emoji/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ productName: 'Молоко' }),
    });
  }

  it.each([
    [
      'NEXT_LOCALE=ru',
      'Генерация картинок сейчас недоступна (квота или ключ провайдера). Выберите обычный emoji.',
    ],
    [
      'NEXT_LOCALE=en',
      'AI image generation is unavailable right now (provider quota or API key). Pick a regular emoji instead.',
    ],
  ])('reports an unavailable provider in the interface language (%s)', async (cookie, error) => {
    doubles.generateEmojiImage.mockRejectedValue(
      new EmojiProviderUnavailableError({ reason: 'quota', provider: 'gemini', model: 'm' })
    );

    const response = await POST(request(cookie));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error, code: 'image_provider_unavailable' });
  });

  it.each([
    ['NEXT_LOCALE=ru', 'Не удалось сгенерировать картинку'],
    ['NEXT_LOCALE=en', 'Failed to generate emoji'],
  ])('reports a general failure in the interface language (%s)', async (cookie, error) => {
    doubles.generateEmojiImage.mockRejectedValue(new Error(marker));

    const response = await POST(request(cookie));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error });
    expect(JSON.stringify(body)).not.toContain(marker);
  });
});

describe('generate success message follows the request language', () => {
  it.each([
    ['NEXT_LOCALE=ru', true, 'Картинка сгенерирована и сохранена в библиотеку эмодзи.'],
    [
      'NEXT_LOCALE=ru',
      false,
      'Картинка сгенерирована, но не сохранена в библиотеку эмодзи: сохраните товар, чтобы она не потерялась.',
    ],
    ['NEXT_LOCALE=en', true, 'Image generated and saved to the emoji library.'],
    [
      'NEXT_LOCALE=en',
      false,
      'Image generated but not saved to the emoji library: save the product to keep it.',
    ],
  ])('%s, libraryRecorded %s', async (cookie, recorded, message) => {
    doubles.generateEmojiImage.mockResolvedValue({
      imageBuffer: Buffer.from('png'),
      provider: 'gemini',
      model: 'model',
      promptVersion: 'v',
      cacheKey: 'k',
    } as never);
    doubles.uploadEmojiImage.mockResolvedValue({
      imageUrl: 'https://utfs.io/f/generated.webp',
      fileName: 'ai-emoji-milk.webp',
    } as never);
    doubles.recordEmojiLibraryItem.mockResolvedValue((recorded ? { id: 'lib-1' } : null) as never);

    const response = await POST(
      new Request('http://localhost:3000/api/emoji/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ productName: 'Молоко' }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ libraryRecorded: recorded, message });
  });
});
