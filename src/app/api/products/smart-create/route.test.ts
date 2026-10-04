// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const marker = 'synthetic-provider-marker-347';

const doubles = vi.hoisted(() => ({
  sdkCalls: [] as string[],
  findUnique: vi.fn(),
  updateUser: vi.fn(),
  findCategories: vi.fn(),
  findProduct: vi.fn(),
  createProduct: vi.fn(),
  analyzeSmartProduct: vi.fn(),
  generateAndUploadEmojiAsset: vi.fn(),
  uploadEmojiImage: vi.fn(),
  uploadEmojiBase64Image: vi.fn(),
  checkRateLimit: vi.fn(),
  requireUser: vi.fn(),
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
  generateEmojiImage: doubles.generateAndUploadEmojiAsset,
  generateAndUploadEmojiAsset: doubles.generateAndUploadEmojiAsset,
  uploadEmojiImage: doubles.uploadEmojiImage,
  uploadEmojiBase64Image: doubles.uploadEmojiBase64Image,
}));

vi.mock('@/lib/services/ai-products', () => ({
  analyzeSmartProduct: doubles.analyzeSmartProduct,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: doubles.findUnique,
      update: doubles.updateUser,
    },
    category: {
      findMany: doubles.findCategories,
    },
    product: {
      findFirst: doubles.findProduct,
      create: doubles.createProduct,
    },
  },
}));

vi.mock('@/lib/auth-guards', () => ({
  requireUser: doubles.requireUser,
  requireAdmin: doubles.requireUser,
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: doubles.checkRateLimit };
});

const { POST } = await import('@/app/api/products/smart-create/route');

const CATEGORY = { id: 'cat-1', name: 'Молочное', nameEn: 'Dairy', order: 1 };

function smartCreateRequest(productName = 'молоко') {
  return new Request('http://localhost:3000/api/products/smart-create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productName }),
  });
}

beforeEach(() => {
  doubles.sdkCalls.length = 0;
  for (const mock of [
    doubles.findUnique,
    doubles.updateUser,
    doubles.findCategories,
    doubles.findProduct,
    doubles.createProduct,
    doubles.analyzeSmartProduct,
    doubles.generateAndUploadEmojiAsset,
    doubles.uploadEmojiImage,
    doubles.uploadEmojiBase64Image,
    doubles.checkRateLimit,
    doubles.requireUser,
  ]) {
    mock.mockReset();
  }

  process.env.GOOGLE_GENAI_API_KEY = 'synthetic-google-genai-key-for-tests';
  process.env.AI_PROVIDER = undefined;
  delete process.env.AI_PROVIDER;

  doubles.requireUser.mockResolvedValue({ session: { user: { id: 'user-1', email: 'u@e.test' } } });
  doubles.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER', createdProductsCount: 0 });
  doubles.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: 0 });
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
  doubles.generateAndUploadEmojiAsset.mockRejectedValue(new Error(marker));
  doubles.uploadEmojiImage.mockRejectedValue(new Error('upload must not run'));
  doubles.uploadEmojiBase64Image.mockRejectedValue(new Error('upload must not run'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GOOGLE_GENAI_API_KEY;
});

describe('AC-7 POST /api/products/smart-create generation failure contract', () => {
  it('creates the product with a Unicode emoji and no custom image', async () => {
    const response = await POST(smartCreateRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.customEmojiGenerated).toBe(false);
    expect(body.needsCustomEmoji).toBe(true);
    expect(doubles.createProduct).toHaveBeenCalledTimes(1);
    const createArgs = doubles.createProduct.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data).toMatchObject({
      name: 'Молоко',
      nameEn: 'Milk',
      emoji: '🥛',
      categoryId: 'cat-1',
      isCustom: false,
      imageUrl: null,
      isGlobal: false,
      createdById: 'user-1',
    });
    expect(doubles.uploadEmojiImage).not.toHaveBeenCalled();
    expect(doubles.uploadEmojiBase64Image).not.toHaveBeenCalled();
    expect(doubles.sdkCalls).toHaveLength(0);
  });
});
