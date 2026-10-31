// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// "Import list from text" end to end on a real PostgreSQL. Only the AI provider is faked (the
// @google/genai SDK); the route handler, rate limiter, AI budget, prompt, response parsing,
// product matching and item creation all run for real. Opt-in like the other
// *.integration.test.ts files: set INTEGRATION_DATABASE_URL to a disposable, migrated database.

const url = process.env.INTEGRATION_DATABASE_URL;

const provider = vi.hoisted(() => ({
  prompts: [] as string[],
  reply: '' as string,
  userId: '',
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async ({ contents }: { contents: string }) => {
        provider.prompts.push(contents);
        return { text: provider.reply };
      },
    };
  },
}));

vi.mock('@/lib/auth-guards', () => ({
  requireUser: async () => ({ session: { user: { id: provider.userId, role: 'USER' } } }),
}));

vi.mock('@/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { createPrismaPgAdapter } = await import('@/lib/prisma-adapter');
  return {
    prisma: new PrismaClient({
      adapter: createPrismaPgAdapter(process.env.INTEGRATION_DATABASE_URL),
    }),
  };
});

type Parsed = {
  nameRu: string;
  nameEn: string;
  categoryName: string;
  emoji: string;
  note?: string;
};

describe.skipIf(!url)('POST /api/lists/import-text on PostgreSQL', () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const dairy = { name: `Молочные продукты ${suffix}`, nameEn: `Dairy ${suffix}` };
  const bakery = { name: `Хлеб и выпечка ${suffix}`, nameEn: `Bread & Bakery ${suffix}` };
  const milk = `Молоко ${suffix}`;
  const eggs = `Яйца ${suffix}`;
  const bread = `Хлеб белый ${suffix}`;

  let db: PrismaClient;
  let route: typeof import('./route');
  let listId: string;
  const categoryIds: string[] = [];

  const catalog = () => ({
    milk: { nameRu: milk, nameEn: `Milk ${suffix}`, categoryName: dairy.nameEn, emoji: '🥛' },
    eggs: { nameRu: eggs, nameEn: `Eggs ${suffix}`, categoryName: dairy.nameEn, emoji: '🥚' },
    bread: {
      nameRu: bread,
      nameEn: `White Bread ${suffix}`,
      categoryName: bakery.nameEn,
      emoji: '🍞',
    },
  });

  async function runImport(text: string, reply: Parsed[] | string) {
    provider.reply = typeof reply === 'string' ? reply : JSON.stringify(reply);
    const productsBefore = await db.product.count({ where: { createdById: provider.userId } });
    const response = await route.POST(
      new Request('http://localhost/api/lists/import-text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, listId }),
      })
    );
    const body = await response.json();
    const items = await db.item.findMany({
      where: { listId },
      include: { product: { select: { name: true, createdById: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const createdProducts =
      (await db.product.count({ where: { createdById: provider.userId } })) - productsBefore;
    return { status: response.status, body, items, createdProducts };
  }

  beforeAll(async () => {
    ({ prisma: db } = (await import('@/lib/prisma')) as unknown as { prisma: PrismaClient });
    route = await import('./route');
    process.env.GOOGLE_GENAI_API_KEY = 'synthetic-google-genai-key-for-tests';
    provider.userId = (
      await db.user.create({ data: { email: `import-${suffix}@example.test` } })
    ).id;
    let order = 2_000_000 + Math.floor(Math.random() * 1_000_000);
    for (const [category, products] of [
      [dairy, [catalog().milk, catalog().eggs]],
      [bakery, [catalog().bread]],
    ] as const) {
      const created = await db.category.create({
        data: { ...category, emoji: '🧺', order: order++ },
      });
      categoryIds.push(created.id);
      for (const product of products) {
        await db.product.create({
          data: {
            name: product.nameRu,
            nameEn: product.nameEn,
            emoji: product.emoji,
            categoryId: created.id,
          },
        });
      }
    }
  });

  afterAll(async () => {
    delete process.env.GOOGLE_GENAI_API_KEY;
    if (!db) return;
    await db.user.deleteMany({ where: { id: provider.userId } });
    await db.category.deleteMany({ where: { id: { in: categoryIds } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    provider.prompts = [];
    listId = (await db.list.create({ data: { userId: provider.userId, name: 'Покупки' } })).id;
  });

  it('adds products that exist in the catalog without creating new ones', async () => {
    const { milk: m, eggs: e, bread: b } = catalog();

    const result = await runImport(`${milk}\n${eggs}\n${bread}`, [m, e, b]);

    expect(provider.prompts[0]).toContain(`${milk}\n${eggs}\n${bread}`);
    expect(result.status).toBe(200);
    expect(result.body.results.failed).toEqual([]);
    expect(result.items.map((item) => item.product.name)).toEqual([milk, eggs, bread]);
    expect(result.createdProducts).toBe(0);
  });

  it('adds existing products when the model writes the category as the prompt lists it', async () => {
    // The prompt lists categories as "Dairy (<Russian name>)" and asks for "exact category
    // names from the list"; a model can return that whole string.
    const listed = (category: { name: string; nameEn: string }) =>
      `${category.nameEn} (${category.name})`;
    const { milk: m, eggs: e, bread: b } = catalog();

    const result = await runImport(`${milk}\n${eggs}\n${bread}`, [
      { ...m, categoryName: listed(dairy) },
      { ...e, categoryName: listed(dairy) },
      { ...b, categoryName: listed(bakery) },
    ]);

    expect(result.status).toBe(200);
    expect(result.body.results.failed).toEqual([]);
    expect(result.items.map((item) => item.product.name)).toEqual([milk, eggs, bread]);
    expect(result.createdProducts).toBe(0);
  });

  it('matches an existing product regardless of letter case and surrounding spaces', async () => {
    const { milk: m } = catalog();

    const result = await runImport(milk.toLowerCase(), [
      { ...m, nameRu: ` ${milk.toLowerCase()} `, nameEn: m.nameEn.toUpperCase() },
    ]);

    expect(result.status).toBe(200);
    expect(result.items.map((item) => item.product.name)).toEqual([milk]);
    expect(result.createdProducts).toBe(0);
  });

  it('adds known products and creates only the unknown ones in a mixed list', async () => {
    const { milk: m, bread: b } = catalog();
    const tarragon = {
      nameRu: `Тархун ${suffix}`,
      nameEn: `Tarragon soda ${suffix}`,
      categoryName: dairy.nameEn,
      emoji: '🥤',
      note: '2 бутылки',
    };

    const result = await runImport(`${milk}\n${bread}\nтархун 2 бутылки`, [m, b, tarragon]);

    expect(result.status).toBe(200);
    expect(result.items.map((item) => [item.product.name, item.note])).toEqual([
      [milk, null],
      [bread, null],
      [tarragon.nameRu, '2 бутылки'],
    ]);
    expect(result.createdProducts).toBe(1);
    expect(result.items[2].product.createdById).toBe(provider.userId);
  });

  it('keeps the valid products when one parsed entry is malformed', async () => {
    const { milk: m, eggs: e } = catalog();

    const result = await runImport(`${milk}\n???\n${eggs}`, [
      m,
      { nameRu: '???', nameEn: '', categoryName: dairy.nameEn, emoji: '' },
      e,
    ]);

    expect(result.status).toBe(200);
    expect(result.items.map((item) => item.product.name)).toEqual([milk, eggs]);
  });
});
