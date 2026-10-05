// @vitest-environment node
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreEnv, snapshotEnv } from '@/test/emoji-image-fixtures';

const BODY_MARKER = 'synthetic-sdk-body-marker-347';
const KEY_MARKER = 'synthetic-key-marker-347';
const HEADERS_MARKER = 'synthetic-headers-marker-347';

const doubles = vi.hoisted(() => ({
  sdkFailure: (() => undefined) as () => unknown,
  sdkCalls: [] as string[],
  uploads: [] as File[],
  findUnique: vi.fn(),
  updateUser: vi.fn(),
  findCategories: vi.fn(),
  findProduct: vi.fn(),
  createProduct: vi.fn(),
  analyzeSmartProduct: vi.fn(),
  checkRateLimit: vi.fn(),
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateImages: async () => {
        doubles.sdkCalls.push('generateImages');
        return doubles.sdkFailure();
      },
      generateContent: async () => {
        doubles.sdkCalls.push('generateContent');
        return doubles.sdkFailure();
      },
    };
  },
}));

vi.mock('openai', () => ({
  default: class {
    images = {
      generate: async () => {
        doubles.sdkCalls.push('images.generate');
        return doubles.sdkFailure();
      },
    };
  },
}));

vi.mock('uploadthing/server', () => ({
  UTApi: class {
    uploadFiles = async (file: File) => {
      doubles.uploads.push(file);
      return { data: { url: 'https://utfs.io/f/synthetic-age-347.png' } };
    };
  },
}));

vi.mock('@/lib/services/ai-products', () => ({
  analyzeSmartProduct: doubles.analyzeSmartProduct,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: doubles.findUnique, update: doubles.updateUser },
    category: { findMany: doubles.findCategories },
    product: { findFirst: doubles.findProduct, create: doubles.createProduct },
  },
}));

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: doubles.requireAdmin,
  requireUser: doubles.requireUser,
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: doubles.checkRateLimit };
});

const { POST: emojiGenerate } = await import('@/app/api/emoji/generate/route');
const { POST: smartCreate } = await import('@/app/api/products/smart-create/route');

const CATEGORY = { id: 'cat-1', name: 'Молочное', nameEn: 'Dairy', order: 1 };
const envSnapshot = snapshotEnv();

/**
 * Every logger of the process is captured with a deep rendering, so a nested SDK error, its raw body
 * headers or its `cause` cannot slip through an argument that `String(arg)` would flatten.
 */
function captureLoggers() {
  const records: Array<{ level: string; text: string }> = [];
  const levels = ['error', 'warn', 'info', 'log', 'debug'] as const;

  for (const level of levels) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      records.push({
        level,
        text: args.map((arg) => inspect(arg, { depth: 8 })).join(' '),
      });
    });
  }

  return records;
}

function emojiGenerateRequest(productName = 'Milk') {
  return new Request('http://localhost:3000/api/emoji/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productName }),
  });
}

function smartCreateRequest(productName = 'молоко') {
  return new Request('http://localhost:3000/api/products/smart-create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productName }),
  });
}

beforeEach(() => {
  doubles.sdkCalls.length = 0;
  doubles.uploads.length = 0;
  process.env.AI_PROVIDER = 'gemini';
  process.env.GOOGLE_IMAGE_MODEL = 'gemini-3.1-flash-image';
  process.env.IMAGEN_MODEL = undefined;
  delete process.env.IMAGEN_MODEL;
  process.env.GOOGLE_GENAI_API_KEY = `${KEY_MARKER}-google`;
  process.env.OPENAI_API_KEY = undefined;
  delete process.env.OPENAI_API_KEY;

  doubles.requireAdmin.mockResolvedValue({ session: { user: { id: 'admin-1', role: 'ADMIN' } } });
  doubles.requireUser.mockResolvedValue({ session: { user: { id: 'user-1', email: 'u@e.test' } } });
  doubles.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: 0 });
  doubles.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER', createdProductsCount: 0 });
  doubles.findCategories.mockResolvedValue([CATEGORY]);
  doubles.findProduct.mockResolvedValue(null);
  doubles.analyzeSmartProduct.mockResolvedValue({
    result: {
      nameRu: 'Молоко',
      nameEn: 'Milk',
      categoryName: 'Dairy',
      emoji: '🥛',
      needsCustomEmoji: true,
    },
    promptVersion: 'ai-products-v1',
    model: 'gemini-3.1-flash',
  });
  doubles.createProduct.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'product-1',
    ...data,
    category: CATEGORY,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(envSnapshot);
});

describe('AC-17 server logs of a provider failure carry allowlisted fields only', () => {
  it('logs class, reason, provider and model without the SDK body for an unavailable provider', async () => {
    doubles.sdkFailure = () => {
      throw Object.assign(
        new Error(
          `429 {"error":{"code":429,"message":"${BODY_MARKER}","status":"RESOURCE_EXHAUSTED"}}`
        ),
        {
          status: 429,
          headers: { 'x-request-id': HEADERS_MARKER },
          cause: { detail: BODY_MARKER, requestHeaders: { authorization: KEY_MARKER } },
        }
      );
    };
    const records = captureLoggers();

    const response = await emojiGenerate(emojiGenerateRequest());
    const bodyText = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(bodyText)).toEqual({
      error:
        'AI image generation is unavailable right now (provider quota or API key). Pick a regular emoji instead.',
      code: 'image_provider_unavailable',
    });
    expect(doubles.sdkCalls).toEqual(['generateContent']);
    expect(records.filter((record) => record.level === 'error')).not.toHaveLength(0);
    const logged = records.map((record) => record.text).join('\n');
    expect(logged).toContain("errorClass: 'EmojiProviderUnavailableError'");
    expect(logged).toContain("reason: 'quota'");
    expect(logged).toContain("provider: 'gemini'");
    expect(logged).toContain("model: 'gemini-3.1-flash-image'");
    expect(logged).not.toContain(BODY_MARKER);
    expect(logged).not.toContain(HEADERS_MARKER);
    expect(logged).not.toContain(KEY_MARKER);
    expect(bodyText).not.toContain(BODY_MARKER);
    expect(bodyText).not.toContain(KEY_MARKER);
  });

  it('logs class, reason, provider and model for an unavailable provider in smart-create', async () => {
    doubles.sdkFailure = () => {
      throw Object.assign(new Error(`403 ${BODY_MARKER}`), {
        status: 403,
        cause: { detail: BODY_MARKER },
      });
    };
    const records = captureLoggers();

    const response = await smartCreate(smartCreateRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.customEmojiGenerated).toBe(false);
    expect(doubles.uploads).toHaveLength(0);
    expect(records.filter((record) => record.level === 'error')).not.toHaveLength(0);
    const logged = records.map((record) => record.text).join('\n');
    expect(logged).toContain("errorClass: 'EmojiProviderUnavailableError'");
    expect(logged).toContain("reason: 'auth'");
    expect(logged).toContain("provider: 'gemini'");
    expect(logged).toContain("model: 'gemini-3.1-flash-image'");
    expect(logged).not.toContain(BODY_MARKER);
    expect(logged).not.toContain(KEY_MARKER);
  });

  it('keeps the previous 500 and logs no raw SDK text for a network failure', async () => {
    doubles.sdkFailure = () => {
      throw Object.assign(new TypeError(`fetch failed for ${BODY_MARKER}`), {
        cause: { detail: BODY_MARKER, url: `https://generativelanguage.example/${BODY_MARKER}` },
      });
    };
    const records = captureLoggers();

    const response = await emojiGenerate(emojiGenerateRequest());
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(bodyText)).toEqual({ error: 'Failed to generate emoji' });
    expect(records.filter((record) => record.level === 'error')).not.toHaveLength(0);
    const logged = records.map((record) => record.text).join('\n');
    expect(logged).toContain("errorClass: 'Error'");
    expect(logged).not.toContain(BODY_MARKER);
    expect(logged).not.toContain(KEY_MARKER);
    expect(bodyText).not.toContain(BODY_MARKER);
  });

  it('keeps a configuration error distinguishable without logging its value', async () => {
    process.env.GOOGLE_IMAGE_MODEL = 'not-a-model-id';
    doubles.sdkFailure = () => {
      throw new Error(`${BODY_MARKER} must not be reached`);
    };
    const records = captureLoggers();

    const response = await emojiGenerate(emojiGenerateRequest());
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(bodyText)).toEqual({ error: 'Failed to generate emoji' });
    expect(doubles.sdkCalls).toHaveLength(0);
    expect(records.filter((record) => record.level === 'error')).not.toHaveLength(0);
    const logged = records.map((record) => record.text).join('\n');
    expect(logged).toContain("errorClass: 'configuration'");
    expect(logged).not.toContain('not-a-model-id');
    expect(logged).not.toContain(KEY_MARKER);
  });

  it('keeps the previous 500 and logs no raw text for a route-level failure', async () => {
    doubles.createProduct.mockRejectedValue(new Error(`Prisma write failed: ${BODY_MARKER}`));
    const records = captureLoggers();

    const response = await smartCreate(smartCreateRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to create product' });
    expect(records.filter((record) => record.level === 'error')).not.toHaveLength(0);
    const logged = records.map((record) => record.text).join('\n');
    expect(logged).toContain("errorClass: 'Error'");
    expect(logged).not.toContain(BODY_MARKER);
    expect(logged).not.toContain(KEY_MARKER);
  });

  it('keeps the previous 500 and logs no raw SDK text for an unclassified provider error', async () => {
    doubles.sdkFailure = () => {
      throw Object.assign(new Error(`500 {"error":{"message":"${BODY_MARKER}"}}`), {
        status: 500,
        headers: { 'x-request-id': HEADERS_MARKER },
        cause: { detail: BODY_MARKER },
      });
    };
    const records = captureLoggers();

    const response = await smartCreate(smartCreateRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.customEmojiGenerated).toBe(false);
    expect(doubles.uploads).toHaveLength(0);
    expect(records.filter((record) => record.level === 'error')).not.toHaveLength(0);
    const logged = records.map((record) => record.text).join('\n');
    expect(logged).toContain("errorClass: 'Error'");
    expect(logged).not.toContain(BODY_MARKER);
    expect(logged).not.toContain(HEADERS_MARKER);
    expect(logged).not.toContain(KEY_MARKER);
  });
});
