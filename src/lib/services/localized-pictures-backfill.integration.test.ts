// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaPgAdapter } from '../prisma-adapter';
import { applyBackfill, planBackfill, TEXT_LOCALE_NONE } from './localized-pictures-backfill';

// Run only through npm run test:localized-pictures-postgres: it creates and removes its own Docker DB.
const url = process.env.INTEGRATION_DATABASE_URL;
const REPO_ROOT = process.cwd();
const CLI_PATH = resolve(REPO_ROOT, 'scripts/localized-pictures-backfill.ts');
const TSX_CLI = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

const LIB_RU = 'https://lib.test/ru.webp';
const LIB_NONE = 'https://lib.test/none.webp';
const LIB_EN = 'https://lib.test/en.webp';

function runCli(args: string[], databaseUrl?: string) {
  const env = { ...process.env };
  if (databaseUrl === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = databaseUrl;
  return spawnSync(process.execPath, [TSX_CLI, CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe.skipIf(!url)('localized picture backfill on disposable PostgreSQL', () => {
  let db: PrismaClient;

  beforeAll(() => {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/localized_pictures_test') {
      throw new Error('This destructive fixture requires the Docker test runner database');
    }
    db = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE list_history_items, list_histories, lists, product_variants, products, categories, users, emoji_library_items RESTART IDENTITY CASCADE'
    );
    await seed();
  });

  async function seed() {
    await db.emojiLibraryItem.createMany({
      data: [
        { id: 'lib-ru', name: 'ru', imageUrl: LIB_RU, source: 'batch', locale: 'ru' },
        { id: 'lib-none', name: 'none', imageUrl: LIB_NONE, source: 'batch', locale: null },
        { id: 'lib-en', name: 'en', imageUrl: LIB_EN, source: 'batch', locale: 'en' },
      ],
    });
    const user = await db.user.create({ data: { id: 'u1', email: 'backfill@test.invalid' } });
    await db.category.create({
      data: { id: 'c1', name: 'Test', nameEn: 'Test', emoji: 'x', order: 1 },
    });
    const base = { categoryId: 'c1', emoji: 'x' };
    // Product rows are created one by one: a createMany batch with Json values was rejected by
    // Prisma 7.10 here ("Unknown argument localizedImages") while each row alone is accepted.
    const productRows = [
      {
        id: 'p1',
        name: 'P1',
        nameEn: 'P1',
        ...base,
        imageUrl: LIB_RU,
        imageUrlEn: 'https://en.test/p1.webp',
        localizedImages: { es: 'https://es.test/p1.webp' },
      },
      { id: 'p2', name: 'P2', nameEn: 'P2', ...base, imageUrl: LIB_NONE },
      {
        id: 'p3',
        name: 'P3',
        nameEn: 'P3',
        ...base,
        imageUrl: 'https://elsewhere.test/p3.webp',
        imageUrlEn: 'https://en.test/p3.webp',
      },
      {
        id: 'p4',
        name: 'P4',
        nameEn: 'P4',
        ...base,
        imageUrl: LIB_EN,
        imageUrlEn: 'https://legacy.test/new.webp',
        localizedImages: { en: 'https://legacy.test/old.webp' },
      },
      { id: 'p5', name: 'P5', nameEn: 'P5', ...base },
    ];
    for (const data of productRows) await db.product.create({ data });
    await db.productVariant.createMany({
      data: [
        {
          id: 'v1',
          name: 'V1',
          nameEn: 'V1',
          emoji: 'x',
          productId: 'p1',
          imageUrl: LIB_RU,
          imageUrlEn: 'https://en.test/v1.webp',
        },
        {
          id: 'v2',
          name: 'V2',
          nameEn: 'V2',
          emoji: 'x',
          productId: 'p2',
          imageUrlEn: 'https://en.test/v2.webp',
        },
      ],
    });
    const list = await db.list.create({ data: { id: 'l1', name: 'L', userId: user.id } });
    const history = await db.listHistory.create({
      data: { id: 'h1', listName: 'L', userId: user.id, listId: list.id },
    });
    const item = {
      historyId: history.id,
      productEmoji: 'x',
      categoryName: 'Test',
      addedAt: new Date(),
    };
    await db.listHistoryItem.createMany({
      data: [
        {
          id: 'hi1',
          ...item,
          productName: 'P1',
          productImageUrl: LIB_RU,
          productImageUrlEn: 'https://en.test/h1.webp',
        },
        { id: 'hi2', ...item, productName: 'H2', productImageUrl: 'https://gone.test/h2.webp' },
        { id: 'hi3', ...item, productName: 'H3' },
      ],
    });
  }

  // Everything a backfill may touch plus the legacy columns, read in a stable order.
  async function snapshot() {
    const [products, variants, history] = await Promise.all([
      db.product.findMany({ orderBy: { id: 'asc' } }),
      db.productVariant.findMany({ orderBy: { id: 'asc' } }),
      db.listHistoryItem.findMany({ orderBy: { id: 'asc' } }),
    ]);
    return { products, variants, history };
  }

  it('dry-run projects the writes and changes nothing', async () => {
    const before = await snapshot();
    const plan = await planBackfill(db);
    expect(await snapshot()).toEqual(before);

    const byModel = Object.fromEntries(plan.models.map((m) => [m.model, m.writeCounts]));
    expect(byModel.product).toEqual({ rows: 4, textLocale: 3, english: 3 });
    expect(byModel.productVariant).toEqual({ rows: 2, textLocale: 1, english: 2 });
    expect(byModel.listHistoryItem).toEqual({ rows: 1, textLocale: 1, english: 1 });
  });

  it('apply writes every row to the expected state and keeps legacy columns', async () => {
    const before = await snapshot();
    const result = await applyBackfill(db);
    const after = await snapshot();

    expect(result.actualAfter.map((c) => c.rows)).toEqual([5, 2, 3]);
    for (const model of result.plan.models) {
      const i = result.plan.models.indexOf(model);
      expect(result.actualAfter[i]).toEqual(model.projectedAfter);
    }

    const p = Object.fromEntries(after.products.map((r) => [r.id, r]));
    expect(p.p1).toMatchObject({
      imageTextLocale: 'ru',
      localizedImages: { es: 'https://es.test/p1.webp', en: 'https://en.test/p1.webp' },
    });
    expect(p.p2).toMatchObject({ imageTextLocale: TEXT_LOCALE_NONE, localizedImages: null });
    expect(p.p3).toMatchObject({
      imageTextLocale: null,
      localizedImages: { en: 'https://en.test/p3.webp' },
    });
    expect(p.p4).toMatchObject({
      imageTextLocale: 'en',
      localizedImages: { en: 'https://legacy.test/new.webp' },
    });
    expect(p.p5).toMatchObject({ imageTextLocale: null, localizedImages: null });

    const v = Object.fromEntries(after.variants.map((r) => [r.id, r]));
    expect(v.v1).toMatchObject({
      imageTextLocale: 'ru',
      localizedImages: { en: 'https://en.test/v1.webp' },
    });
    expect(v.v2).toMatchObject({
      imageTextLocale: null,
      localizedImages: { en: 'https://en.test/v2.webp' },
    });

    const h = Object.fromEntries(after.history.map((r) => [r.id, r]));
    expect(h.hi1).toMatchObject({
      imageTextLocale: 'ru',
      localizedImages: { en: 'https://en.test/h1.webp' },
    });
    expect(h.hi2).toMatchObject({ imageTextLocale: null, localizedImages: null });
    expect(h.hi3).toMatchObject({ imageTextLocale: null, localizedImages: null });

    // Legacy columns are untouched.
    for (const [old, now] of [
      ...before.products.map((r, i) => [r, after.products[i]]),
      ...before.variants.map((r, i) => [r, after.variants[i]]),
    ] as const) {
      expect([now!.imageUrl, now!.imageUrlEn]).toEqual([old!.imageUrl, old!.imageUrlEn]);
    }
    for (const [old, now] of before.history.map((r, i) => [r, after.history[i]] as const)) {
      expect([now.productImageUrl, now.productImageUrlEn]).toEqual([
        old.productImageUrl,
        old.productImageUrlEn,
      ]);
    }

    // Every row with a legacy English URL carries the same address under en.
    for (const r of [...after.products, ...after.variants]) {
      if (r.imageUrlEn !== null)
        expect((r.localizedImages as Record<string, string>).en).toBe(r.imageUrlEn);
    }
    for (const r of after.history) {
      if (r.productImageUrlEn !== null)
        expect((r.localizedImages as Record<string, string>).en).toBe(r.productImageUrlEn);
    }
  });

  it('rerun on unchanged data writes nothing', async () => {
    await applyBackfill(db);
    const stamped = await db.product.findMany({
      select: { id: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
    const again = await applyBackfill(db);
    expect(again.appliedWrites).toBe(0);
    const after = await db.product.findMany({
      select: { id: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(stamped);
  });

  it('reapplies after legacy edits: changed and cleared URLs, then zero writes', async () => {
    await applyBackfill(db);

    // Legacy app edits made after the first run (the legacy columns are the only thing it changes).
    const UNKNOWN = 'https://elsewhere.test/p1-changed.webp';
    await db.product.update({ where: { id: 'p1' }, data: { imageUrl: UNKNOWN, imageUrlEn: null } });
    await db.product.update({ where: { id: 'p2' }, data: { imageUrl: LIB_RU } });
    await db.product.update({ where: { id: 'p4' }, data: { imageUrlEn: null } });
    await db.productVariant.update({ where: { id: 'v1' }, data: { imageUrl: null } });
    await db.listHistoryItem.update({
      where: { id: 'hi1' },
      data: { productImageUrl: 'https://gone.test/h1.webp' },
    });

    const plan = await planBackfill(db);
    expect(plan.models.map((m) => m.writeCounts.rows)).toEqual([3, 1, 1]);

    const result = await applyBackfill(db);
    expect(result.appliedWrites).toBe(5);

    const after = await snapshot();
    const p = Object.fromEntries(after.products.map((r) => [r.id, r]));
    // Unknown main URL: the stale language is cleared; the other locale stays, the English copy goes.
    expect(p.p1).toMatchObject({
      imageTextLocale: null,
      localizedImages: { es: 'https://es.test/p1.webp' },
    });
    // Changed to a library URL: the language follows the new picture.
    expect(p.p2).toMatchObject({ imageTextLocale: 'ru', localizedImages: null });
    // Cleared legacy English URL: the only stored locale was en, so the column is SQL Null.
    expect(p.p4).toMatchObject({ imageTextLocale: 'en', localizedImages: null });
    // Legacy columns still reflect the legacy edits.
    expect(p.p1).toMatchObject({ imageUrl: UNKNOWN, imageUrlEn: null });

    const v = Object.fromEntries(after.variants.map((r) => [r.id, r]));
    expect(v.v1).toMatchObject({
      imageTextLocale: null,
      localizedImages: { en: 'https://en.test/v1.webp' },
    });

    const h = Object.fromEntries(after.history.map((r) => [r.id, r]));
    expect(h.hi1).toMatchObject({
      imageTextLocale: null,
      localizedImages: { en: 'https://en.test/h1.webp' },
    });

    // The repeat after the correct reapply writes nothing and changes no timestamp.
    const stamped = await db.product.findMany({
      select: { id: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
    const again = await applyBackfill(db);
    expect(again.appliedWrites).toBe(0);
    expect(
      await db.product.findMany({ select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } })
    ).toEqual(stamped);
  });

  it('rolls back every write when a later write fails', async () => {
    const before = await snapshot();
    let writes = 0;
    await expect(
      applyBackfill(db, {
        onRowWritten: () => {
          writes += 1;
          if (writes === 3) throw new Error('simulated failure');
        },
      })
    ).rejects.toThrow('simulated failure');
    expect(await snapshot()).toEqual(before);
  });

  it('CLI: dry-run by default, --apply writes, no URLs in output, DATABASE_URL required', () => {
    const missing = runCli([]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('DATABASE_URL is not set');

    const dry = runCli([], url);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('[DRY-RUN]');
    expect(dry.stdout).not.toMatch(/https?:\/\//);

    const applied = runCli(['--apply'], url);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('[APPLY]');
    expect(applied.stdout).not.toMatch(/https?:\/\//);
  });
});
