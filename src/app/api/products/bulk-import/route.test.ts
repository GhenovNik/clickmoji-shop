// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The bulk-import report is read by the administrator, so every reason in it is in the
// interface language, and so is the category name; counts, ids and both product names are data.

const doubles = vi.hoisted(() => ({
  processProductBatch: vi.fn(),
  existing: new Set<string>(),
}));

vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => ({ session: { user: { id: 'admin-1', role: 'ADMIN' } } }),
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 9, resetAt: 0 }) };
});

vi.mock('@/lib/ai-quota', () => ({ enforceAiQuota: async () => null }));

vi.mock('@/lib/services/ai-products', () => ({
  processProductBatch: doubles.processProductBatch,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    category: {
      findMany: async () => [{ id: 'drinks', name: 'Напитки', nameEn: 'Drinks' }],
    },
    product: {
      findFirst: async ({ where }: { where: { OR: Array<{ name?: string }> } }) =>
        where.OR.some((condition) => condition.name && doubles.existing.has(condition.name))
          ? { id: 'old' }
          : null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-1', ...data }),
    },
  },
}));

const { POST } = await import('./route');

function runImport(locale: 'ru' | 'en') {
  return POST(
    new Request('http://localhost:3000/api/products/bulk-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `NEXT_LOCALE=${locale}` },
      body: JSON.stringify({ productNames: ['Тархун', 'Квас', 'Шуруп'] }),
    })
  );
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  doubles.existing = new Set(['Квас']);
  doubles.processProductBatch.mockResolvedValue({
    products: [
      { nameRu: 'Тархун', nameEn: 'Tarragon soda', categoryName: 'Drinks', emoji: '🥤' },
      { nameRu: 'Квас', nameEn: 'Kvass', categoryName: 'Drinks', emoji: '🍺' },
      { nameRu: 'Шуруп', nameEn: 'Screw', categoryName: 'Hardware', emoji: '🔩' },
    ],
    promptVersion: 'v',
    model: 'm',
  });
});

describe('POST /api/products/bulk-import report language', () => {
  it.each([
    [
      'ru' as const,
      'Напитки',
      'Категория «Hardware» не найдена',
      'Такой товар уже есть',
      'Импортировано товаров: 1, пропущено дублей: 1, с ошибкой: 1',
    ],
    [
      'en' as const,
      'Drinks',
      'Category "Hardware" not found',
      'Product already exists',
      'Imported 1 product, 1 skipped (duplicates), 1 failed',
    ],
  ])('%s', async (locale, categoryName, failedReason, skippedReason, message) => {
    const response = await runImport(locale);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe(message);
    expect(body).toMatchObject({ promptVersion: 'v', model: 'm' });
    expect(body.results.success).toEqual([
      {
        id: 'new-1',
        name: 'Тархун',
        nameEn: 'Tarragon soda',
        emoji: '🥤',
        category: categoryName,
      },
    ]);
    expect(body.results.skipped).toEqual([
      { name: 'Квас', nameEn: 'Kvass', reason: skippedReason },
    ]);
    expect(body.results.failed).toEqual([
      {
        product: { nameRu: 'Шуруп', nameEn: 'Screw', categoryName: 'Hardware', emoji: '🔩' },
        reason: failedReason,
      },
    ]);
  });
});
