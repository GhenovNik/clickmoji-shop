// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// Ranking by the interface language on a real PostgreSQL with pg_trgm. Opt-in like
// src/lib/ai-quota.integration.test.ts: set INTEGRATION_DATABASE_URL to a disposable, migrated
// database.

const url = process.env.INTEGRATION_DATABASE_URL;

vi.mock('@/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { createPrismaPgAdapter } = await import('@/lib/prisma-adapter');
  return {
    prisma: new PrismaClient({
      adapter: createPrismaPgAdapter(process.env.INTEGRATION_DATABASE_URL),
    }),
  };
});

describe.skipIf(!url)('searchProducts on PostgreSQL', () => {
  let db: PrismaClient;
  let searchProducts: typeof import('./product-search').searchProducts;
  let categoryId: string;
  const suffix = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    ({ prisma: db } = (await import('@/lib/prisma')) as unknown as { prisma: PrismaClient });
    ({ searchProducts } = await import('./product-search'));
    const order = 900000 + Math.floor(Math.random() * 90000);
    categoryId = (
      await db.category.create({
        data: { name: `Тест ${suffix}`, nameEn: `Test ${suffix}`, emoji: '🧪', order },
      })
    ).id;
    // Almonds match the Russian prefix of the query, Mint the English one.
    for (const [name, nameEn] of [
      [`Мята${suffix}`, `Mint${suffix}`],
      [`Миндаль${suffix}`, `Almonds${suffix}`],
      [`Кабачок${suffix}`, `Zucchini${suffix}`],
    ]) {
      await db.product.create({
        data: { name, nameEn, emoji: '🧪', categoryId, isGlobal: true, imageUrlEn: null },
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.category.deleteMany({ where: { id: categoryId } });
    await db.$disconnect();
  });

  it('ranks matches in the interface language first', async () => {
    const ru = await searchProducts({ term: `мин`, userId: null, locale: 'ru' });
    const en = await searchProducts({ term: `min`, userId: null, locale: 'en' });

    expect(ru.filter((p) => p.name.endsWith(suffix))[0]?.name).toBe(`Миндаль${suffix}`);
    expect(en.filter((p) => p.name.endsWith(suffix))[0]?.nameEn).toBe(`Mint${suffix}`);
  });

  it('finds a product by the other language too', async () => {
    const russianQueryInEnglishUi = await searchProducts({
      term: `кабачок${suffix}`,
      userId: null,
      locale: 'en',
    });
    const englishQueryInRussianUi = await searchProducts({
      term: `zucchini${suffix}`,
      userId: null,
      locale: 'ru',
    });

    expect(russianQueryInEnglishUi.map((p) => p.nameEn)).toContain(`Zucchini${suffix}`);
    expect(englishQueryInRussianUi.map((p) => p.name)).toContain(`Кабачок${suffix}`);
  });

  it('returns what the UI needs to show the result in either language', async () => {
    const [result] = await searchProducts({
      term: `zucchini${suffix}`,
      userId: null,
      locale: 'en',
    });

    expect(result).toMatchObject({ imageUrlEn: null });
    expect(result.category).toMatchObject({
      nameEn: `Test ${suffix}`,
      isCustom: false,
      imageUrl: null,
    });
  });
});
