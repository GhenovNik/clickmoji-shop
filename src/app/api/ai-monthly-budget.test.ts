// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auth: vi.fn(),
  monthlyRows: new Map<string, { reservedMicroUsd: bigint; spentMicroUsd: bigint }>(),
  dailyCounts: new Map<string, number>(),
  failBudgetDb: false,
  failReconcileDb: false,
  forceZeroReconcileRows: false,
  failBudgetAfterReservations: Infinity,
  monthlyReservationsCount: 0,
  textCalls: [] as Array<{ model: string; prompt: string }>,
  textBehavior: vi.fn(),
  googleImageCalls: [] as Array<{ model: string; prompt: string }>,
  googleImageBehavior: vi.fn(),
  openaiImageCalls: [] as Array<{ model: string; prompt: string }>,
  openaiImageBehavior: vi.fn(),
  uploadCalls: 0,
  createdProducts: [] as Array<Record<string, unknown>>,
  categories: [{ id: 'cat-1', name: 'Молочное', nameEn: 'Dairy', order: 1 }],
  catalogProducts: [] as Array<{
    id: string;
    name: string;
    nameEn: string;
    categoryId: string;
  }>,
}));

vi.mock('@/lib/auth-guards', () => ({
  requireUser: doubles.requireUser,
  requireAdmin: doubles.requireUser,
}));

vi.mock('@/lib/auth', () => ({
  auth: doubles.auth,
}));

vi.mock('@/lib/auth-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-security')>();
  return { ...actual, checkRateLimit: async () => ({ allowed: true, remaining: 10, resetAt: 0 }) };
});

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: {
        model: string;
        contents: string;
        config?: { responseModalities?: string[] };
      }) => {
        if (params.config?.responseModalities?.includes('IMAGE')) {
          doubles.googleImageCalls.push({ model: params.model, prompt: params.contents });
          return doubles.googleImageBehavior(params);
        }
        doubles.textCalls.push({ model: params.model, prompt: params.contents });
        return doubles.textBehavior(params);
      },
      generateImages: async (params: { model: string; prompt: string }) => {
        doubles.googleImageCalls.push({ model: params.model, prompt: params.prompt });
        return doubles.googleImageBehavior(params);
      },
    };
  },
}));

vi.mock('openai', () => ({
  default: class {
    images = {
      generate: async (params: { model: string; prompt: string }) => {
        doubles.openaiImageCalls.push({ model: params.model, prompt: params.prompt });
        return doubles.openaiImageBehavior(params);
      },
    };
  },
}));

vi.mock('uploadthing/server', () => ({
  UTApi: class {
    uploadFiles = async () => {
      doubles.uploadCalls += 1;
      return { data: { url: 'https://utfs.io/f/generated.webp' }, error: null };
    };
  },
}));

vi.mock('@/lib/services/emoji-image-normalize', () => ({
  NORMALIZED_EMOJI_MIME: 'image/webp',
  normalizeEmojiImage: async (buf: Buffer) => buf,
}));

vi.mock('@/lib/services/emoji-library', () => ({
  recordEmojiLibraryItem: async () => ({ id: 'lib-1' }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('ai_monthly_budgets')) {
        if (doubles.failBudgetDb) {
          throw new Error('relation "ai_monthly_budgets" does not exist');
        }
        if (sql.includes('INSERT INTO ai_monthly_budgets')) {
          if (
            doubles.failBudgetDb ||
            doubles.monthlyReservationsCount >= doubles.failBudgetAfterReservations
          ) {
            throw new Error('relation "ai_monthly_budgets" does not exist');
          }
          const key = (values[0] as Date).toISOString();
          const ceiling = BigInt(values[1] as bigint | number);
          const limit = BigInt(values[values.length - 1] as bigint | number);
          const cur = doubles.monthlyRows.get(key) ?? {
            reservedMicroUsd: BigInt(0),
            spentMicroUsd: BigInt(0),
          };
          if (cur.spentMicroUsd + cur.reservedMicroUsd + ceiling > limit) return [];
          doubles.monthlyReservationsCount += 1;
          const next = {
            reservedMicroUsd: cur.reservedMicroUsd + ceiling,
            spentMicroUsd: cur.spentMicroUsd,
          };
          doubles.monthlyRows.set(key, next);
          return [next];
        }
        if (sql.includes('UPDATE ai_monthly_budgets')) {
          if (doubles.failReconcileDb) {
            throw new Error('relation "ai_monthly_budgets" reconcile error');
          }
          if (doubles.forceZeroReconcileRows) {
            return [];
          }
          const ceiling = BigInt(values[0] as bigint | number);
          const actual = BigInt(values[1] as bigint | number);
          const key = (values[2] as Date).toISOString();
          const cur = doubles.monthlyRows.get(key);
          if (!cur || cur.reservedMicroUsd < ceiling) {
            return [];
          }
          const next = {
            reservedMicroUsd: cur.reservedMicroUsd - ceiling,
            spentMicroUsd: cur.spentMicroUsd + actual,
          };
          doubles.monthlyRows.set(key, next);
          return [next];
        }
      }
      if (sql.includes('ai_usage_counters')) {
        const key = `${values[0]}:${(values[1] as Date).toISOString()}`;
        const limit = Number(values[values.length - 1]);
        const cur = doubles.dailyCounts.get(key) ?? 0;
        if (cur >= limit) return [];
        doubles.dailyCounts.set(key, cur + 1);
        return [{ count: cur + 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('ai_usage_counters')) {
        const key = `${values[0]}:${(values[1] as Date).toISOString()}`;
        const cur = doubles.dailyCounts.get(key) ?? 0;
        if (cur > 0) doubles.dailyCounts.set(key, cur - 1);
        return 1;
      }
      return 0;
    }),
    list: {
      findMany: async () => [{ id: 'list-1', name: 'Main', _count: { items: 0 } }],
      findUnique: async () => ({ id: 'list-1', userId: 'user-1' }),
    },
    category: {
      findMany: async () => doubles.categories,
    },
    user: {
      findUnique: async () => ({ id: 'user-1', role: 'USER', createdProductsCount: 0 }),
      update: async () => ({}),
    },
    product: {
      findFirst: async () => null,
      findMany: async () => doubles.catalogProducts,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `prod-${doubles.createdProducts.length + 1}`, ...data };
        doubles.createdProducts.push(created);
        return created;
      },
    },
    item: {
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
  },
}));

const importTextRoute = await import('@/app/api/lists/import-text/route');
const smartCreateRoute = await import('@/app/api/products/smart-create/route');
const bulkImportRoute = await import('@/app/api/products/bulk-import/route');
const emojiGenerateRoute = await import('@/app/api/emoji/generate/route');
const listsRoute = await import('@/app/api/lists/route');

const { AI_MONTHLY_BUDGET_USD_ENV } = await import('@/lib/ai-budget');
const {
  estimateEmojiPromptTokens,
  estimateImageCallCeilingMicroUsd,
  estimateShoppingListPromptTokens,
  estimateTextCallCeilingMicroUsd,
} = await import('@/lib/ai-pricing');
const { AI_INPUT_LIMITS } = await import('@/lib/ai-input-validation');

const VALID_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-bytes'),
]).toString('base64');

function jsonReq(
  path: string,
  body: unknown,
  locale = 'ru',
  extraHeaders?: Record<string, string>
) {
  return new Request(new URL(path, 'http://localhost'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `NEXT_LOCALE=${locale}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function formatUsd(micro: bigint): string {
  const whole = micro / BigInt(1_000_000);
  const frac = String(micro % BigInt(1_000_000)).padStart(6, '0');
  return `${whole}.${frac}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.monthlyRows.clear();
  doubles.dailyCounts.clear();
  doubles.failBudgetDb = false;
  doubles.failReconcileDb = false;
  doubles.forceZeroReconcileRows = false;
  doubles.failBudgetAfterReservations = Infinity;
  doubles.monthlyReservationsCount = 0;
  doubles.textCalls.length = 0;
  doubles.googleImageCalls.length = 0;
  doubles.openaiImageCalls.length = 0;
  doubles.uploadCalls = 0;
  doubles.createdProducts.length = 0;
  doubles.categories = [{ id: 'cat-1', name: 'Молочное', nameEn: 'Dairy', order: 1 }];
  doubles.catalogProducts = [];

  delete process.env[AI_MONTHLY_BUDGET_USD_ENV];
  delete process.env.AI_PROVIDER;
  delete process.env.AI_DAILY_CALLS_PER_USER;
  delete process.env.AI_DAILY_CALLS_PER_ADMIN;
  delete process.env.GOOGLE_TEXT_MODEL;
  delete process.env.GOOGLE_TEXT_MODEL_FALLBACK;
  delete process.env.GOOGLE_IMAGE_MODEL;
  delete process.env.OPENAI_IMAGE_MODEL;
  process.env.GOOGLE_GENAI_API_KEY = 'synthetic-google-key';
  process.env.OPENAI_API_KEY = 'synthetic-openai-key';

  doubles.requireUser.mockResolvedValue({ session: { user: { id: 'admin-1', role: 'ADMIN' } } });
  doubles.auth.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN' } });

  doubles.textBehavior.mockImplementation(async (params: { contents: string }) => {
    if (params.contents.includes('shopping list parser')) {
      return {
        text: JSON.stringify([
          { nameRu: 'Молоко', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' },
        ]),
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 40 },
      };
    }
    if (params.contents.includes('Given a list of product names')) {
      return {
        text: JSON.stringify([
          { nameRu: 'Молоко', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' },
        ]),
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 40 },
      };
    }
    return {
      text: JSON.stringify({
        nameRu: 'Тархун',
        nameEn: 'Tarragon soda',
        categoryName: 'Dairy',
        emoji: '🥤',
        needsCustomEmoji: true,
      }),
      usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 50 },
    };
  });

  doubles.googleImageBehavior.mockResolvedValue({
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ inlineData: { mimeType: 'image/png', data: VALID_PNG } }] },
      },
    ],
    usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 1120 },
  });

  doubles.openaiImageBehavior.mockResolvedValue({
    data: [{ b64_json: VALID_PNG }],
    usage: {
      input_tokens: 80,
      output_tokens: 1000,
      input_tokens_details: { text_tokens: 80, image_tokens: 0 },
      output_tokens_details: { text_tokens: 0, image_tokens: 1000 },
    },
  });

  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('monthly AI budget across all HTTP AI entry points', () => {
  it('enforces exact boundary at ceiling vs ceiling - 1 across text and image routes', async () => {
    const textCeiling = estimateTextCallCeilingMicroUsd({
      maxPromptTokens: estimateShoppingListPromptTokens({
        text: 'Молоко',
        categories: doubles.categories,
        catalog: [],
      }),
    });
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = formatUsd(textCeiling - BigInt(1));

    const deniedImport = await importTextRoute.POST(
      jsonReq('/api/lists/import-text', { text: 'Молоко', listId: 'list-1' })
    );
    expect(deniedImport.status).toBe(503);
    expect(doubles.textCalls).toHaveLength(0);

    // Exact ceiling passes.
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = formatUsd(textCeiling);
    const allowedImport = await importTextRoute.POST(
      jsonReq('/api/lists/import-text', { text: 'Молоко', listId: 'list-1' })
    );
    expect(allowedImport.status).toBe(200);
    expect(doubles.textCalls).toHaveLength(1);

    // Image exact boundary (tied to actual prompt tokens for "Milk").
    doubles.monthlyRows.clear();
    const imgCeiling = estimateImageCallCeilingMicroUsd({
      maxPromptTokens: estimateEmojiPromptTokens('Milk'),
    });
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = formatUsd(imgCeiling - BigInt(1));
    const deniedImg = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', { productName: 'Milk' })
    );
    expect(deniedImg.status).toBe(503);
    expect(doubles.googleImageCalls).toHaveLength(0);

    process.env[AI_MONTHLY_BUDGET_USD_ENV] = formatUsd(imgCeiling);
    const allowedImg = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', { productName: 'Milk' })
    );
    expect(allowedImg.status).toBe(200);
    expect(doubles.googleImageCalls).toHaveLength(1);
  });

  it('enforces atomic concurrent reservations across routes without over-allocating', async () => {
    const textCeiling = estimateTextCallCeilingMicroUsd({
      maxPromptTokens: estimateShoppingListPromptTokens({
        text: 'Молоко',
        categories: doubles.categories,
        catalog: [],
      }),
    });
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = formatUsd(textCeiling * BigInt(2));

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let notifyTwo!: () => void;
    const twoInFlight = new Promise<void>((resolve) => {
      notifyTwo = resolve;
    });

    const defaultImpl = doubles.textBehavior.getMockImplementation()!;
    doubles.textBehavior.mockImplementation(async (params) => {
      inFlight += 1;
      if (inFlight === 2) notifyTwo();
      await barrier;
      return defaultImpl(params);
    });

    const requests = [
      importTextRoute.POST(jsonReq('/api/lists/import-text', { text: 'Молоко', listId: 'list-1' })),
      importTextRoute.POST(jsonReq('/api/lists/import-text', { text: 'Сыр', listId: 'list-1' })),
      importTextRoute.POST(jsonReq('/api/lists/import-text', { text: 'Кефир', listId: 'list-1' })),
      importTextRoute.POST(jsonReq('/api/lists/import-text', { text: 'Хлеб', listId: 'list-1' })),
    ];

    await twoInFlight;
    release();
    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);

    expect(statuses).toEqual([200, 200, 503, 503]);
    expect(doubles.textCalls).toHaveLength(2);
  });

  it('fails closed on accounting failure with localized AI-only unavailability while non-AI routes continue working', async () => {
    doubles.failBudgetDb = true;

    const routes = [
      () =>
        importTextRoute.POST(
          jsonReq('/api/lists/import-text', { text: 'Молоко', listId: 'list-1' }, 'ru')
        ),
      () =>
        smartCreateRoute.POST(
          jsonReq('/api/products/smart-create', { productName: 'Тархун' }, 'ru')
        ),
      () =>
        bulkImportRoute.POST(
          jsonReq('/api/products/bulk-import', { productNames: ['Молоко'] }, 'ru')
        ),
      () => emojiGenerateRoute.POST(jsonReq('/api/emoji/generate', { productName: 'Milk' }, 'ru')),
    ];

    for (const call of routes) {
      const res = await call();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'AI временно недоступен. Попробуйте позже.' });
    }

    const enRes = await importTextRoute.POST(
      jsonReq('/api/lists/import-text', { text: 'Milk', listId: 'list-1' }, 'en')
    );
    expect(enRes.status).toBe(503);
    expect(await enRes.json()).toEqual({
      error: 'AI is temporarily unavailable. Please try again later.',
    });

    expect(doubles.textCalls).toHaveLength(0);
    expect(doubles.googleImageCalls).toHaveLength(0);

    // Non-AI route remains operational.
    const listsRes = await listsRoute.GET(new Request('http://localhost/api/lists'));
    expect(listsRes.status).toBe(200);
  });

  it('returns localized temporary unavailability when monthly cap is exhausted and skips only optional image in smart-create stage 2', async () => {
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = '0';

    const ruRes = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', { productName: 'Milk' }, 'ru')
    );
    expect(ruRes.status).toBe(503);
    expect(ruRes.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(await ruRes.json()).toEqual({
      error: 'AI-функции временно недоступны. Попробуйте позже.',
    });

    const enRes = await bulkImportRoute.POST(
      jsonReq('/api/products/bulk-import', { productNames: ['Milk'] }, 'en')
    );
    expect(enRes.status).toBe(503);
    expect(await enRes.json()).toEqual({
      error: 'AI features are temporarily unavailable. Please try again later.',
    });

    // smart-create: stage 1 allowed, stage 2 fails monthly reservation -> creates product with Unicode emoji.
    const textCeiling = estimateTextCallCeilingMicroUsd();
    process.env[AI_MONTHLY_BUDGET_USD_ENV] = formatUsd(textCeiling);
    doubles.failBudgetAfterReservations = 1;
    const smartRes = await smartCreateRoute.POST(
      jsonReq('/api/products/smart-create', { productName: 'Тархун' }, 'en')
    );
    expect(smartRes.status).toBe(200);
    const smartBody = await smartRes.json();
    expect(smartBody).toMatchObject({ customEmojiGenerated: false, needsCustomEmoji: true });
    expect(doubles.textCalls).toHaveLength(1);
    expect(doubles.googleImageCalls).toHaveLength(0);
  });

  it('fails closed on unbounded OpenAI image provider before reserving budget or calling OpenAI, while preserving bounded smart-create text', async () => {
    process.env.AI_PROVIDER = 'gpt-image';
    process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare';

    const ruImgRes = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', { productName: 'Milk' }, 'ru')
    );
    expect(ruImgRes.status).toBe(503);
    expect(await ruImgRes.json()).toEqual({ error: 'AI временно недоступен. Попробуйте позже.' });

    const enImgRes = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', { productName: 'Milk' }, 'en')
    );
    expect(enImgRes.status).toBe(503);
    expect(await enImgRes.json()).toEqual({
      error: 'AI is temporarily unavailable. Please try again later.',
    });

    expect(doubles.openaiImageCalls).toHaveLength(0);
    expect(doubles.uploadCalls).toBe(0);
    expect(doubles.monthlyRows.size).toBe(0);
    expect(doubles.dailyCounts.size).toBe(0);

    // smart-create Stage 1 (bounded Gemini text) remains operational; Stage 2 (unbounded gpt-image) is skipped.
    const smartRes = await smartCreateRoute.POST(
      jsonReq('/api/products/smart-create', { productName: 'Тархун' }, 'en')
    );
    expect(smartRes.status).toBe(200);
    expect(await smartRes.json()).toMatchObject({
      customEmojiGenerated: false,
      needsCustomEmoji: true,
    });
    expect(doubles.textCalls).toHaveLength(1);
    expect(doubles.openaiImageCalls).toHaveLength(0);
    expect(doubles.uploadCalls).toBe(0);
  });
});

describe('server-side input bounds before providers (400/413)', () => {
  it('blocks oversized import-text input (2001 chars -> 400), invalid listId (400), and oversized payload (413) before reading full body or calling provider', async () => {
    const okRes = await importTextRoute.POST(
      jsonReq('/api/lists/import-text', {
        text: 'a'.repeat(AI_INPUT_LIMITS.MAX_IMPORT_TEXT_CHARS),
        listId: 'list-1',
      })
    );
    expect(okRes.status).toBe(200);
    doubles.textCalls.length = 0;
    doubles.monthlyRows.clear();
    doubles.dailyCounts.clear();

    const tooLong = await importTextRoute.POST(
      jsonReq('/api/lists/import-text', {
        text: 'a'.repeat(AI_INPUT_LIMITS.MAX_IMPORT_TEXT_CHARS + 1),
        listId: 'list-1',
      })
    );
    expect(tooLong.status).toBe(400);

    const badListId = await importTextRoute.POST(
      jsonReq('/api/lists/import-text', {
        text: 'Молоко',
        listId: 'bad list id\n'.repeat(10),
      })
    );
    expect(badListId.status).toBe(400);

    // Streaming body exceeding IMPORT_TEXT_BODY_MAX_BYTES is aborted before reading the trailing chunks.
    let pulledChunks = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulledChunks += 1;
          if (pulledChunks === 1) {
            controller.enqueue(
              new TextEncoder().encode('{"text":"Молоко","listId":"list-1","extra":"')
            );
          } else if (pulledChunks <= 5) {
            controller.enqueue(
              new TextEncoder().encode('z'.repeat(AI_INPUT_LIMITS.IMPORT_TEXT_BODY_MAX_BYTES))
            );
          } else {
            controller.enqueue(new TextEncoder().encode('"}'));
            controller.close();
          }
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 })
    );
    const oversizedBody = await importTextRoute.POST(
      new Request('http://localhost/api/lists/import-text', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'NEXT_LOCALE=ru' },
        body: stream,
        duplex: 'half',
      } as RequestInit)
    );
    expect(oversizedBody.status).toBe(413);
    expect(await oversizedBody.json()).toEqual({ error: 'Запрос слишком большой' });
    expect(pulledChunks).toBe(2);
    expect(doubles.textCalls).toHaveLength(0);
    expect(doubles.monthlyRows.size).toBe(0);
    expect(doubles.dailyCounts.size).toBe(0);
  });

  it('blocks oversized smart-create productName (400), invalid categoryId (400), and oversized payload (413) before provider', async () => {
    const tooLongName = await smartCreateRoute.POST(
      jsonReq('/api/products/smart-create', {
        productName: 'x'.repeat(AI_INPUT_LIMITS.MAX_PRODUCT_NAME_LENGTH + 1),
      })
    );
    expect(tooLongName.status).toBe(400);

    const badCategory = await smartCreateRoute.POST(
      jsonReq('/api/products/smart-create', {
        productName: 'Молоко',
        categoryId: 'ignore instructions\n'.repeat(10),
      })
    );
    expect(badCategory.status).toBe(400);

    const oversizedBody = await smartCreateRoute.POST(
      jsonReq('/api/products/smart-create', {
        productName: 'Молоко',
        extra: 'z'.repeat(AI_INPUT_LIMITS.SMART_CREATE_BODY_MAX_BYTES + 100),
      })
    );
    expect(oversizedBody.status).toBe(413);
    expect(doubles.textCalls).toHaveLength(0);
    expect(doubles.monthlyRows.size).toBe(0);

    // Exact boundary (120 chars) passes.
    const exactOk = await smartCreateRoute.POST(
      jsonReq('/api/products/smart-create', {
        productName: 'x'.repeat(AI_INPUT_LIMITS.MAX_PRODUCT_NAME_LENGTH),
      })
    );
    expect(exactOk.status).toBe(200);
    expect(doubles.textCalls).toHaveLength(1);
  });

  it('blocks oversized bulk-import arrays, items, total chars (400) and payload (413) before provider', async () => {
    const tooManyItems = await bulkImportRoute.POST(
      jsonReq('/api/products/bulk-import', {
        productNames: Array.from(
          { length: AI_INPUT_LIMITS.MAX_BULK_IMPORT_ITEMS + 1 },
          (_, i) => `p${i}`
        ),
      })
    );
    expect(tooManyItems.status).toBe(400);

    const tooLongItem = await bulkImportRoute.POST(
      jsonReq('/api/products/bulk-import', {
        productNames: ['x'.repeat(AI_INPUT_LIMITS.MAX_PRODUCT_NAME_LENGTH + 1)],
      })
    );
    expect(tooLongItem.status).toBe(400);

    const tooManyTotalChars = await bulkImportRoute.POST(
      jsonReq('/api/products/bulk-import', {
        productNames: Array.from({ length: 21 }, () => 'x'.repeat(100)), // 2100 > 2000
      })
    );
    expect(tooManyTotalChars.status).toBe(400);

    const oversizedBody = await bulkImportRoute.POST(
      jsonReq('/api/products/bulk-import', {
        productNames: ['Milk'],
        extra: 'z'.repeat(AI_INPUT_LIMITS.BULK_IMPORT_BODY_MAX_BYTES + 100),
      })
    );
    expect(oversizedBody.status).toBe(413);
    expect(doubles.textCalls).toHaveLength(0);
    expect(doubles.monthlyRows.size).toBe(0);
  });

  it('blocks oversized emoji/generate productName, description (400) and payload (413) before provider', async () => {
    const tooLongName = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', {
        productName: 'x'.repeat(AI_INPUT_LIMITS.MAX_PRODUCT_NAME_LENGTH + 1),
      })
    );
    expect(tooLongName.status).toBe(400);

    const tooLongDesc = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', {
        productName: 'Milk',
        description: 'd'.repeat(AI_INPUT_LIMITS.MAX_EMOJI_DESCRIPTION_LENGTH + 1),
      })
    );
    expect(tooLongDesc.status).toBe(400);

    const oversizedBody = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', {
        productName: 'Milk',
        extra: 'z'.repeat(AI_INPUT_LIMITS.EMOJI_GENERATE_BODY_MAX_BYTES + 100),
      })
    );
    expect(oversizedBody.status).toBe(413);
    expect(doubles.googleImageCalls).toHaveLength(0);
    expect(doubles.monthlyRows.size).toBe(0);

    // Exact boundaries (120 + 500) pass.
    const exactOk = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', {
        productName: 'x'.repeat(AI_INPUT_LIMITS.MAX_PRODUCT_NAME_LENGTH),
        description: 'd'.repeat(AI_INPUT_LIMITS.MAX_EMOJI_DESCRIPTION_LENGTH),
      })
    );
    expect(exactOk.status).toBe(200);
    expect(doubles.googleImageCalls).toHaveLength(1);
  });

  it('propagates accounting failure across text and image routes when reconciliation returns zero rows or fails', async () => {
    doubles.forceZeroReconcileRows = true;

    const importRes = await importTextRoute.POST(
      jsonReq('/api/lists/import-text', { text: 'Молоко', listId: 'list-1' }, 'en')
    );
    expect(importRes.status).toBe(500);

    const bulkRes = await bulkImportRoute.POST(
      jsonReq('/api/products/bulk-import', { productNames: ['Молоко'] }, 'en')
    );
    expect(bulkRes.status).toBe(500);

    const smartRes = await smartCreateRoute.POST(
      jsonReq('/api/products/smart-create', { productName: 'Тархун' }, 'en')
    );
    expect(smartRes.status).toBe(500);

    const imgRes = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', { productName: 'Milk' }, 'en')
    );
    expect(imgRes.status).toBe(500);
  });

  it('returns localized 400 on invalid JSON across all four AI routes without leaking body content in diagnostics', async () => {
    const secretMarker = 'secret_invalid_json_marker_xyz';
    const rawInvalidBody = `{"productName": "${secretMarker}", invalid`;
    const routes = [
      {
        fn: importTextRoute.POST,
        path: '/api/lists/import-text',
        ru: 'Некорректный запрос',
        en: 'Invalid request',
      },
      {
        fn: smartCreateRoute.POST,
        path: '/api/products/smart-create',
        ru: 'Некорректный запрос',
        en: 'Invalid request',
      },
      {
        fn: bulkImportRoute.POST,
        path: '/api/products/bulk-import',
        ru: 'Некорректный запрос',
        en: 'Invalid request',
      },
      {
        fn: emojiGenerateRoute.POST,
        path: '/api/emoji/generate',
        ru: 'Некорректный запрос',
        en: 'Invalid request',
      },
    ];

    for (const route of routes) {
      for (const [locale, expectedError] of [
        ['ru', route.ru],
        ['en', route.en],
      ] as const) {
        const res = await route.fn(
          new Request(new URL(route.path, 'http://localhost'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: `NEXT_LOCALE=${locale}` },
            body: rawInvalidBody,
          })
        );
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json).toEqual({ error: expectedError });
        expect(JSON.stringify(json)).not.toContain(secretMarker);
      }
    }

    expect(doubles.textCalls).toHaveLength(0);
    expect(doubles.googleImageCalls).toHaveLength(0);
    expect(doubles.monthlyRows.size).toBe(0);
    expect(doubles.dailyCounts.size).toBe(0);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secretMarker);
  });

  it('preserves localized 413 when server-assembled prompt exceeds MAX_TEXT_PROMPT_BYTES across all text AI routes with zero provider calls and preserved daily limit', async () => {
    // Make categories huge so smart-create and bulk-import assembled prompts exceed 120,000 bytes.
    doubles.categories = Array.from({ length: 150 }, (_, i) => ({
      id: `cat-${i}`,
      name: `Категория-${i}-${'к'.repeat(500)}`,
      nameEn: `Category-${i}-${'c'.repeat(500)}`,
      order: i,
    }));

    // 1. smart-create (ru + en)
    for (const [locale, expected] of [
      ['ru', 'Запрос слишком большой'],
      ['en', 'Request payload is too large'],
    ] as const) {
      const res = await smartCreateRoute.POST(
        jsonReq('/api/products/smart-create', { productName: 'Молоко' }, locale)
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: expected });
    }

    // 2. bulk-import (ru + en)
    for (const [locale, expected] of [
      ['ru', 'Запрос слишком большой'],
      ['en', 'Request payload is too large'],
    ] as const) {
      const res = await bulkImportRoute.POST(
        jsonReq('/api/products/bulk-import', { productNames: ['Молоко'] }, locale)
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: expected });
    }

    // 3. import-text (ru + en) with huge catalog
    doubles.categories = [{ id: 'cat-1', name: 'Молочное', nameEn: 'Dairy', order: 1 }];
    doubles.catalogProducts = Array.from({ length: 200 }, (_, i) => ({
      id: `prod-${i}`,
      name: `Молоко-${i}-${'м'.repeat(400)}`,
      nameEn: `Milk-${i}-${'m'.repeat(400)}`,
      categoryId: 'cat-1',
    }));
    for (const [locale, expected] of [
      ['ru', 'Запрос слишком большой'],
      ['en', 'Request payload is too large'],
    ] as const) {
      const res = await importTextRoute.POST(
        jsonReq('/api/lists/import-text', { text: 'Молоко', listId: 'list-1' }, locale)
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: expected });
    }

    expect(doubles.textCalls).toHaveLength(0);
    // Daily quota must remain unconsumed after prompt-limit rejection.
    expect([...doubles.dailyCounts.values()].every((v) => v === 0)).toBe(true);

    // Daily limit still blocks before assembling/running when exhausted.
    process.env.AI_DAILY_CALLS_PER_ADMIN = '0';
    const disabledRes = await importTextRoute.POST(
      jsonReq('/api/lists/import-text', { text: 'Молоко', listId: 'list-1' }, 'en')
    );
    delete process.env.AI_DAILY_CALLS_PER_ADMIN;
    expect(disabledRes.status).toBe(403);
    expect(doubles.textCalls).toHaveLength(0);
  });

  it('records full actual overspend and fails closed with HTTP 500 across image and text routes when provider usage exceeds reserved ceiling', async () => {
    doubles.googleImageBehavior.mockResolvedValueOnce({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: VALID_PNG } }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 5_000, // exceeds 4,096 maxOutputTokens on gemini-3.1-flash-lite-image
        totalTokenCount: 5_100,
      },
    });
    const imgRes = await emojiGenerateRoute.POST(
      jsonReq('/api/emoji/generate', { productName: 'Milk' }, 'en')
    );
    expect(imgRes.status).toBe(500);
    expect(doubles.uploadCalls).toBe(0);
    const [monthRow] = [...doubles.monthlyRows.values()];
    expect(monthRow.reservedMicroUsd).toBe(BigInt(0));
    expect(monthRow.spentMicroUsd).toBe(BigInt(Math.ceil(100 * 0.25) + Math.ceil(5_000 * 30)));

    // smart-create Stage 2 overspend must NOT silently fall back to 200 OK; it fails closed (500).
    doubles.monthlyRows.clear();
    doubles.googleImageBehavior.mockResolvedValueOnce({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: VALID_PNG } }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 5_000,
        totalTokenCount: 5_100,
      },
    });
    const smartRes = await smartCreateRoute.POST(
      jsonReq('/api/products/smart-create', { productName: 'Тархун' }, 'en')
    );
    expect(smartRes.status).toBe(500);
    expect(doubles.createdProducts).toHaveLength(0);

    // Text route overspend (e.g. provider returns token counts above reserved text ceiling):
    // records full actual spend, keeps daily limit intact, and fails closed with HTTP 500.
    doubles.monthlyRows.clear();
    doubles.dailyCounts.clear();
    doubles.textBehavior.mockResolvedValueOnce({
      text: JSON.stringify([
        { nameRu: 'Молоко', nameEn: 'Milk', categoryName: 'Dairy', emoji: '🥛' },
      ]),
      usageMetadata: {
        promptTokenCount: 50_000,
        candidatesTokenCount: 10_000,
        totalTokenCount: 60_000,
      },
    });
    const importOverspendRes = await importTextRoute.POST(
      jsonReq('/api/lists/import-text', { text: 'Молоко', listId: 'list-1' }, 'en')
    );
    expect(importOverspendRes.status).toBe(500);
    const [textMonthRow] = [...doubles.monthlyRows.values()];
    expect(textMonthRow.reservedMicroUsd).toBe(BigInt(0));
    expect(textMonthRow.spentMicroUsd).toBe(
      BigInt(Math.ceil(50_000 * 1.5) + Math.ceil(10_000 * 7.5))
    );
  });
});
