// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Paid AI calls reachable by a regular user (text import, smart-create and the image generation
// inside smart-create) take a unit of the shared daily budget before the provider is called.
// The budget lives in PostgreSQL; here a fake $queryRaw stands in for the conditional upsert.

const doubles = vi.hoisted(() => ({
  requireUser: vi.fn(),
  parseShoppingListText: vi.fn(),
  analyzeSmartProduct: vi.fn(),
  generateAndUploadEmojiAsset: vi.fn(),
  createProduct: vi.fn(),
  budget: { used: 0, fail: false },
}));

vi.mock('@/lib/auth-guards', () => ({ requireUser: doubles.requireUser }));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0 }) };
});

vi.mock('@/lib/services/ai-products', () => ({
  parseShoppingListText: doubles.parseShoppingListText,
  analyzeSmartProduct: doubles.analyzeSmartProduct,
}));

vi.mock('@/lib/services/emoji-assets', () => ({
  generateAndUploadEmojiAsset: doubles.generateAndUploadEmojiAsset,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    // INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit RETURNING count
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join('?').includes('ai_usage_counters')) throw new Error('unexpected SQL');
      if (doubles.budget.fail) throw new Error('relation "ai_usage_counters" does not exist');
      const limit = values[values.length - 1] as number;
      if (doubles.budget.used >= limit) return [];
      doubles.budget.used += 1;
      return [{ count: doubles.budget.used }];
    },
    list: { findUnique: async () => ({ id: 'list-b', userId: 'user-b' }) },
    category: {
      findMany: async () => [{ id: 'cat-1', name: 'Напитки', nameEn: 'Drinks', order: 1 }],
    },
    user: {
      findUnique: async () => ({ id: 'user-b', role: 'USER', createdProductsCount: 0 }),
      update: async () => ({}),
    },
    product: {
      findFirst: async () => null,
      create: doubles.createProduct,
    },
    item: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  },
}));

const importText = await import('@/app/api/lists/import-text/route');
const smartCreate = await import('@/app/api/products/smart-create/route');

const post = (body: unknown) =>
  new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const runImport = () => importText.POST(post({ text: 'тархун', listId: 'list-b' }));
const runSmartCreate = () => smartCreate.POST(post({ productName: 'Тархун' }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  delete process.env.AI_DAILY_CALLS_PER_USER;
  process.env.GOOGLE_GENAI_API_KEY = 'synthetic-google-genai-key-for-tests';
  doubles.budget.used = 0;
  doubles.budget.fail = false;
  doubles.requireUser.mockResolvedValue({ session: { user: { id: 'user-b', role: 'USER' } } });
  doubles.parseShoppingListText.mockResolvedValue({
    products: [{ nameRu: 'Тархун', nameEn: 'Tarragon soda', categoryName: 'Drinks', emoji: '🥤' }],
    promptVersion: 'v',
    model: 'm',
  });
  doubles.analyzeSmartProduct.mockResolvedValue({
    result: {
      nameRu: 'Тархун',
      nameEn: 'Tarragon soda',
      categoryName: 'Drinks',
      emoji: '🥤',
      needsCustomEmoji: true,
    },
    promptVersion: 'v',
    model: 'm',
  });
  doubles.generateAndUploadEmojiAsset.mockResolvedValue({ imageUrl: 'https://utfs.io/f/x.png' });
  doubles.createProduct.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'new-product',
    ...data,
  }));
});

describe('daily budget of paid AI calls', () => {
  it('stops text import once the budget is used up, before the provider is called', async () => {
    process.env.AI_DAILY_CALLS_PER_USER = '2';

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await runImport()).status);

    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(doubles.parseShoppingListText).toHaveBeenCalledTimes(2);
  });

  it('stops smart-create once the budget is used up, before the provider is called', async () => {
    process.env.AI_DAILY_CALLS_PER_USER = '0';

    const response = await runSmartCreate();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(doubles.analyzeSmartProduct).not.toHaveBeenCalled();
    expect(doubles.generateAndUploadEmojiAsset).not.toHaveBeenCalled();
  });

  it('counts the image generation inside smart-create and falls back to the emoji', async () => {
    process.env.AI_DAILY_CALLS_PER_USER = '1';

    const response = await runSmartCreate();

    expect(response.status).toBe(200);
    expect(doubles.analyzeSmartProduct).toHaveBeenCalledTimes(1);
    expect(doubles.generateAndUploadEmojiAsset).not.toHaveBeenCalled();
    expect(doubles.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ emoji: '🥤', isCustom: false, imageUrl: null }),
      })
    );
  });

  it('takes one unit for the analysis and one for the image when both are allowed', async () => {
    const response = await runSmartCreate();

    expect(response.status).toBe(200);
    expect(doubles.generateAndUploadEmojiAsset).toHaveBeenCalledTimes(1);
    expect(doubles.budget.used).toBe(2);
  });

  it('refuses the paid call when the budget cannot be checked', async () => {
    doubles.budget.fail = true;

    const importResponse = await runImport();
    const smartResponse = await runSmartCreate();

    expect([importResponse.status, smartResponse.status]).toEqual([503, 503]);
    expect(doubles.parseShoppingListText).not.toHaveBeenCalled();
    expect(doubles.analyzeSmartProduct).not.toHaveBeenCalled();
  });
});
