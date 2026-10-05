// @vitest-environment node
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  candidateWith,
  generateContentResponse,
  imagePart,
  setEnv,
  snapshotEnv,
  SYNTHETIC_GOOGLE_KEY,
} from '@/test/emoji-image-fixtures';

const doubles = vi.hoisted(() => ({
  generateContentImpl: (() => undefined) as (params: Record<string, unknown>) => unknown,
  generateImagesCalls: [] as Array<Record<string, unknown>>,
  generateContentCalls: [] as Array<Record<string, unknown>>,
  imagesGenerateCalls: [] as Array<Record<string, unknown>>,
  uploadFilesCalls: [] as Array<File>,
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
      generateImages: async (params: Record<string, unknown>) => {
        doubles.generateImagesCalls.push(params);
        return { generatedImages: [{ image: { imageBytes: 'iVBORw0KGgo=' } }] };
      },
      generateContent: async (params: Record<string, unknown>) => {
        doubles.generateContentCalls.push(params);
        return doubles.generateContentImpl(params);
      },
    };
  },
}));

vi.mock('openai', () => ({
  default: class {
    images = {
      generate: async (params: Record<string, unknown>) => {
        doubles.imagesGenerateCalls.push(params);
        return { data: [{ b64_json: 'iVBORw0KGgo=' }] };
      },
    };
  },
}));

vi.mock('uploadthing/server', () => ({
  UTApi: class {
    uploadFiles = async (file: File) => {
      doubles.uploadFilesCalls.push(file);
      return { data: { url: 'https://utfs.io/f/should-not-happen.png' } };
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

function captureConsoleError() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => inspect(arg, { depth: 8 })).join(' '));
  });
  return { lines, spy };
}

beforeEach(() => {
  doubles.generateImagesCalls.length = 0;
  doubles.generateContentCalls.length = 0;
  doubles.imagesGenerateCalls.length = 0;
  doubles.uploadFilesCalls.length = 0;
  doubles.generateContentImpl = () =>
    generateContentResponse(candidateWith([imagePart()], 'IMAGE_SAFETY'));
  setEnv({
    AI_PROVIDER: 'gemini',
    GOOGLE_IMAGE_MODEL: 'gemini-3.1-flash-image',
    IMAGEN_MODEL: 'imagen-4.0-fast-generate-001',
    GOOGLE_GENAI_API_KEY: SYNTHETIC_GOOGLE_KEY,
  });

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
  restoreEnvAfterEach();
});

function restoreEnvAfterEach() {
  for (const [key, value] of envSnapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('AC-11 blocked Google image responses reach the routes as before', () => {
  it('logs the blocked error class and returns the previous 500 body', async () => {
    const { lines } = captureConsoleError();

    const response = await emojiGenerate(
      new Request('http://localhost:3000/api/emoji/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productName: 'Milk' }),
      })
    );
    const bodyText = await response.text();

    expect(doubles.generateContentCalls).toHaveLength(1);
    expect(doubles.generateContentCalls[0]?.model).toBe('gemini-3.1-flash-image');
    expect(response.status).toBe(500);
    expect(JSON.parse(bodyText)).toEqual({ error: 'Failed to generate emoji' });
    expect(lines.join('\n')).toMatch(/blocked/);
    expect(lines.join('\n')).not.toContain(SYNTHETIC_GOOGLE_KEY);
  });

  it('falls back to a Unicode emoji in smart-create and logs the error class', async () => {
    const { lines } = captureConsoleError();

    const response = await smartCreate(
      new Request('http://localhost:3000/api/products/smart-create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productName: 'молоко' }),
      })
    );
    const body = await response.json();

    expect(doubles.generateContentCalls).toHaveLength(1);
    expect(response.status).toBe(200);
    expect(body.customEmojiGenerated).toBe(false);
    const createArgs = doubles.createProduct.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data).toMatchObject({ emoji: '🥛', isCustom: false, imageUrl: null });
    expect(doubles.uploadFilesCalls).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/blocked/);
    expect(lines.join('\n')).not.toContain(SYNTHETIC_GOOGLE_KEY);
  });
});
