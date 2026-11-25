// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaPgAdapter } from '../prisma-adapter';
import {
  applyCell,
  cellRef,
  findBatchFiles,
  libraryTags,
  loadCatalogIndex,
  normalizeCatalogName,
  planProduct,
  sliceSheet,
  type AppliedCell,
  type CellPlan,
  type CellImages,
  type ManifestBatch,
  type ManifestCell,
  type ReplacementAuthorization,
} from './emoji-batch-import';

// AGE-1667 C6 on a disposable PostgreSQL: the 144 queue targets, imported from synthetic sheets with
// a fake uploader (no network, no UploadThing). Run only through npm run test:queue-replace-postgres,
// which creates and removes its own Docker database.
const url = process.env.INTEGRATION_DATABASE_URL;
const REPO_ROOT = process.cwd();
const CLI_PATH = resolve(REPO_ROOT, 'scripts/emoji-import.ts');
const TSX_CLI = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const DOCS = 'docs/emoji-batches';

const snapshot = JSON.parse(
  readFileSync(join(DOCS, 'catalog-snapshot-2026-11-25.json'), 'utf8')
) as {
  categories: {
    name: string;
    nameEn: string;
    emoji: string;
    hasImage: boolean;
    products: {
      name: string;
      nameEn: string;
      emoji: string;
      variants?: { name: string; nameEn: string; emoji: string }[];
    }[];
  }[];
};
const manifest = JSON.parse(
  readFileSync(join(DOCS, 'queue-manifest.json'), 'utf8')
) as ManifestBatch[];
const cellsOf = (action: ManifestCell['action']) =>
  manifest.flatMap((b) => b.cells.filter((c) => c.action === action));

const OLD = (name: string) => `https://old.example.test/${encodeURIComponent(name)}.webp`;
const MANUAL = 'https://manual.example.test/hand-edit.webp';
const UPLOADS = 'https://uploads.example.test/';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const childEnv = { ...process.env, ...env } as NodeJS.ProcessEnv;
  if (env.DATABASE_URL === undefined) delete childEnv.DATABASE_URL;
  return spawnSync(process.execPath, [TSX_CLI, CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Synthetic sheets: one 3 × 3 sheet per batch (and an English one for text batches), every cell a
// different colour so the normalisation keeps a visible picture.
async function syntheticSheets(batches: ManifestBatch[], skip: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'emoji-queue-sheets-'));
  tempDirs.push(dir);
  const sheet = async (seed: number) => {
    const cells = Array.from({ length: 9 }, (_, i) => {
      const x = (i % 3) * 100;
      const y = Math.floor(i / 3) * 100;
      const hue = (seed * 37 + i * 29) % 360;
      return `<circle cx="${x + 50}" cy="${y + 50}" r="38" fill="hsl(${hue},70%,50%)"/>`;
    }).join('');
    return sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#fff"/>${cells}</svg>`
      )
    )
      .png()
      .toBuffer();
  };
  for (const [i, batch] of batches.entries()) {
    if (skip.includes(batch.batch)) continue;
    writeFileSync(join(dir, `${batch.batch}.png`), await sheet(i + 1));
    if (batch.kind === 'text')
      writeFileSync(join(dir, `${batch.batch}-en.png`), await sheet(i + 100));
  }
  return dir;
}

async function seedCatalogue(db: PrismaClient) {
  await db.$executeRaw`TRUNCATE TABLE emoji_library_items, list_history_items, favorites, variant_favorites, items, lists, list_histories, product_variants, products, categories RESTART IDENTITY CASCADE`;
  for (const [order, category] of snapshot.categories.entries()) {
    await db.category.create({
      data: {
        name: category.name,
        nameEn: category.nameEn,
        emoji: category.emoji,
        order,
        // The five categories with a picture keep their old one until the replacement.
        isCustom: category.hasImage,
        imageUrl: category.hasImage ? OLD(category.name) : null,
      },
    });
  }
  for (const category of snapshot.categories) {
    const row = await db.category.findUniqueOrThrow({ where: { name: category.name } });
    for (const product of category.products) {
      await db.product.create({
        data: {
          name: product.name,
          nameEn: product.nameEn,
          emoji: product.emoji || '📦',
          categoryId: row.id,
          isGlobal: true,
          isCustom: false,
          variants: {
            create: (product.variants ?? []).map((v) => ({
              name: v.name,
              nameEn: v.nameEn,
              emoji: v.emoji || '📦',
            })),
          },
        },
      });
    }
  }
}

// Cells of a sheet as they are cut from it. The normalisation of each picture (about 0.8 s per cell
// on the test machine) is covered by its own tests; these tests check what the database does with
// the 144 targets, so the cut cells go in as they are.
async function cutPictures(dir: string, batch: ManifestBatch) {
  const files = findBatchFiles(dir, batch.batch);
  const pictures = new Map<number, CellImages>();
  if (!files.sheet) return pictures;
  const ru = await sliceSheet(readFileSync(files.sheet), batch.cells.length);
  const en =
    batch.kind === 'text' && files.sheetEn
      ? await sliceSheet(readFileSync(files.sheetEn), batch.cells.length)
      : [];
  batch.cells.forEach((cell, i) => pictures.set(cell.cell, { ru: ru[i], en: en[i] }));
  return pictures;
}

// One cell at a time, the way the import does: read, plan, apply.
async function importBatches(
  db: PrismaClient,
  dir: string,
  batches: ManifestBatch[],
  auth: Map<string, ReplacementAuthorization> | undefined,
  upload: (image: Buffer, name: string) => Promise<string>
) {
  const results: { ref: string; cell: ManifestCell; result: AppliedCell }[] = [];
  const missing: string[] = [];
  const index = await loadCatalogIndex(db);
  for (const batch of batches) {
    const images = await cutPictures(dir, batch);
    for (const cell of batch.cells) {
      const ref = cellRef(batch.batch, cell.cell);
      const picture = images.get(cell.cell);
      if (!picture) {
        missing.push(ref);
        continue;
      }
      const plan: CellPlan = {
        ref,
        batch: batch.batch,
        batchKind: batch.kind ?? 'universal',
        cell,
        images: picture,
        stored: {},
        product: planProduct(cell, index),
        replacement:
          cell.action === 'replace' ? auth?.get(normalizeCatalogName(cell.name)) : undefined,
      };
      results.push({ ref, cell, result: await applyCell(db, plan, upload) });
    }
  }
  return { results, missing };
}

const fakeUploader = () => {
  let n = 0;
  return async (_image: Buffer, name: string) =>
    `${UPLOADS}${++n}-${encodeURIComponent(name)}.webp`;
};

// The authorisation for the seeded old state: the old URL and the old isCustom flag (seeded true).
function authFor(cells: ManifestCell[], expectedIsCustom = true) {
  return new Map(
    cells.map((cell) => [
      normalizeCatalogName(cell.name),
      { expectedImageUrl: OLD(cell.name), expectedIsCustom },
    ])
  );
}

// A fake uploader that also records the category name each upload was for.
function recordingUploader() {
  const inner = fakeUploader();
  const names: string[] = [];
  const upload = async (image: Buffer, name: string) => {
    names.push(name);
    return inner(image, name);
  };
  return { upload, names };
}

describe.skipIf(!url)(
  'queue of 144 targets with replacements on disposable PostgreSQL (AGE-1667 C6)',
  () => {
    let db: PrismaClient;
    const replaceCells = cellsOf('replace');
    const replaceAuth = () => authFor(replaceCells);

    beforeAll(() => {
      const parsed = new URL(url!);
      if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/queue_replace_test') {
        throw new Error('This destructive fixture requires the Docker test runner database');
      }
      db = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
    });

    afterAll(async () => {
      await db?.$disconnect();
    });

    beforeEach(async () => {
      await seedCatalogue(db);
    });

    it('plans all 144 targets with none missing and none ambiguous (dry run)', async () => {
      const index = await loadCatalogIndex(db);
      const kinds = manifest.flatMap((b) => b.cells).map((cell) => planProduct(cell, index).kind);
      expect(kinds).toHaveLength(144);
      const count = (kind: string) => kinds.filter((k) => k === kind).length;
      expect(count('link')).toBe(123);
      expect(count('variant')).toBe(2);
      expect(count('category')).toBe(19);
      expect(kinds.filter((k) => !['link', 'variant', 'category'].includes(k))).toEqual([]);
    });

    it(
      'imports every synthetic target with zero exclusions, then replays as a no-op',
      { timeout: 180_000 },
      async () => {
        const dir = await syntheticSheets(manifest);
        const upload = fakeUploader();
        const first = await importBatches(db, dir, manifest, replaceAuth(), upload);

        expect(first.missing).toEqual([]);
        expect(first.results).toHaveLength(144);
        const excluded = first.results.filter(
          ({ result }) =>
            result.product === 'conflict' ||
            result.product === 'not-found' ||
            result.product === 'ambiguous'
        );
        expect(excluded.map((e) => e.ref)).toEqual([]);
        expect(first.results.reduce((n, r) => n + r.result.uploaded, 0)).toBe(144 + 49);
        expect(await db.emojiLibraryItem.count()).toBe(144 + 49);

        for (const cell of replaceCells) {
          const row = await db.category.findUniqueOrThrow({ where: { name: cell.name } });
          const library = await db.emojiLibraryItem.findFirstOrThrow({
            where: { sourceRef: `queue-011#${cell.cell}` },
          });
          expect(row.imageUrl).toBe(library.imageUrl);
          expect(row.isCustom).toBe(true);
          expect(row.imageUrl).not.toBe(OLD(cell.name));
        }

        const replay = await importBatches(db, dir, manifest, replaceAuth(), upload);
        expect(replay.results.filter((r) => r.result.changed || r.result.uploaded > 0)).toEqual([]);
        expect(replay.results.filter((r) => r.result.product === 'conflict')).toEqual([]);
        expect(await db.emojiLibraryItem.count()).toBe(144 + 49);
      }
    );

    it('conflicts on a stale old URL while the other four replacements apply', async () => {
      await db.category.update({ where: { name: 'Напитки' }, data: { imageUrl: MANUAL } });
      const dir = await syntheticSheets(manifest);
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      const { results } = await importBatches(db, dir, batch, replaceAuth(), fakeUploader());

      const drinks = results.find((r) => r.cell.name === 'Напитки')!;
      expect(drinks.result.product).toBe('conflict');
      expect(drinks.result.conflict).toContain('не содержит ожидаемую старую картинку');
      expect(
        await db.emojiLibraryItem.findUnique({ where: { sourceRef: 'queue-011#1' } })
      ).toBeNull();
      expect((await db.category.findUniqueOrThrow({ where: { name: 'Напитки' } })).imageUrl).toBe(
        MANUAL
      );

      const others = results.filter((r) => r.cell.name !== 'Напитки');
      expect(others.map((r) => r.result.product)).toEqual(Array(4).fill('category'));
      for (const cell of replaceCells.filter((c) => c.name !== 'Напитки')) {
        const row = await db.category.findUniqueOrThrow({ where: { name: cell.name } });
        expect(row.imageUrl).toContain(UPLOADS);
      }
    });

    it('refuses a replacement without an authorised URL before any upload or write', async () => {
      const dir = await syntheticSheets(manifest);
      const upload = fakeUploader();
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      await expect(importBatches(db, dir, batch, undefined, upload)).rejects.toThrow(
        'needs its authorised old URL'
      );
      expect(await db.emojiLibraryItem.count()).toBe(0);
      for (const cell of replaceCells) {
        expect((await db.category.findUniqueOrThrow({ where: { name: cell.name } })).imageUrl).toBe(
          OLD(cell.name)
        );
      }
    });

    it('a manual edit landing between the check and the update is never overwritten', async () => {
      const dir = await syntheticSheets(manifest);
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      // The other writer changes the category while this run uploads the picture.
      const upload = async () => {
        await db.category.update({ where: { name: 'Напитки' }, data: { imageUrl: MANUAL } });
        return `${UPLOADS}race.webp`;
      };
      const { results } = await importBatches(db, dir, batch, replaceAuth(), upload);

      const drinks = results.find((r) => r.cell.name === 'Напитки')!;
      expect(drinks.result.product).toBe('conflict');
      expect(drinks.result.conflict).toContain('изменилась после проверки');
      expect((await db.category.findUniqueOrThrow({ where: { name: 'Напитки' } })).imageUrl).toBe(
        MANUAL
      );
    });

    it('two concurrent runs for one replacement end on one picture and no conflict', async () => {
      const dir = await syntheticSheets(manifest);
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      const [a, b] = await Promise.all([
        importBatches(db, dir, batch, replaceAuth(), fakeUploader()),
        importBatches(db, dir, batch, replaceAuth(), fakeUploader()),
      ]);
      const outcomes = [...a.results, ...b.results].filter((r) => r.cell.name === 'Напитки');
      expect(
        outcomes.filter((r) => r.result.product === 'conflict').map((r) => r.result.conflict)
      ).toEqual([]);

      const row = await db.category.findUniqueOrThrow({ where: { name: 'Напитки' } });
      const libraries = await db.emojiLibraryItem.findMany({ where: { sourceRef: 'queue-011#1' } });
      expect(libraries).toHaveLength(1);
      expect(row.imageUrl).toBe(libraries[0].imageUrl);
      expect(libraries[0].tags).toEqual(libraryTags(batch[0].cells[0]));
    });

    it('reports an ambiguous replacement category and writes only the library record', async () => {
      await db.category.create({
        data: { name: 'напитки', nameEn: 'drinks', emoji: '🥤', order: 100 },
      });
      const dir = await syntheticSheets(manifest);
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      const { results } = await importBatches(db, dir, batch, replaceAuth(), fakeUploader());

      const drinks = results.find((r) => r.cell.name === 'Напитки')!;
      expect(drinks.result.product).toBe('ambiguous');
      expect((await db.category.findUniqueOrThrow({ where: { name: 'Напитки' } })).imageUrl).toBe(
        OLD('Напитки')
      );
      expect(await db.emojiLibraryItem.count()).toBe(5);
    });

    it('reports a missing sheet on the command line and writes nothing for it', async () => {
      const dir = await syntheticSheets(manifest, ['queue-011']);
      const result = runCli(['--dir', dir, '--batch', 'queue-011'], {
        DATABASE_URL: url,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Missing: queue-011');
      expect(result.stdout).toContain('Замен картинок категорий: 5');
    });

    it('dry run of the whole queue matches 144 catalogue targets with none not found or ambiguous', async () => {
      // No sheets: the preview still checks every target against the catalogue, and reports each
      // batch as missing. Picture reading is not what this check is about.
      const dir = mkdtempSync(join(tmpdir(), 'emoji-queue-dry-'));
      tempDirs.push(dir);
      const ids = manifest.map((b) => b.batch).join(',');
      const result = runCli(['--dir', dir, '--batch', ids], { DATABASE_URL: url });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'Целей: 144; найдено в каталоге: 144; ненайденных: 0; неоднозначных: 0.'
      );
      expect(result.stdout).toContain(`Missing: ${manifest.map((b) => b.batch).join(', ')}`);
      expect(result.stdout).toContain('Замен картинок категорий: 5; без --replace-auth');
    });

    it('dry run with a replacement authorisation shows the replacement conditions, uploading nothing', async () => {
      const dir = await syntheticSheets(
        manifest,
        manifest.map((b) => b.batch).filter((id) => id !== 'queue-011')
      );
      const authPath = join(dir, 'replace-auth.json');
      writeFileSync(
        authPath,
        JSON.stringify({
          replacements: replaceCells.map((cell) => ({
            category: cell.name,
            expectedImageUrl: OLD(cell.name),
            expectedIsCustom: true,
          })),
        })
      );
      const result = runCli(['--dir', dir, '--batch', 'queue-011', '--replace-auth', authPath], {
        DATABASE_URL: url,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'Замен картинок категорий: 5; старые URL проверены по --replace-auth.'
      );
      expect(result.stdout).not.toContain('Applied ');
      expect(await db.emojiLibraryItem.count()).toBe(0);
    });

    it('apply without an authorisation file stops before any upload', async () => {
      const dir = await syntheticSheets(manifest);
      const result = runCli(['--dir', dir, '--batch', 'queue-011', '--apply'], {
        DATABASE_URL: url,
        UPLOADTHING_TOKEN: 'offline-test-token',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('требуют --replace-auth');
      expect(result.stdout).not.toContain('Preview:');
      expect(await db.emojiLibraryItem.count()).toBe(0);
    });

    it('apply with an incomplete authorisation file is refused before any read or upload', async () => {
      const dir = await syntheticSheets(manifest);
      const authPath = join(dir, 'replace-auth.json');
      writeFileSync(
        authPath,
        JSON.stringify({
          replacements: [
            { category: 'Напитки', expectedImageUrl: OLD('Напитки'), expectedIsCustom: true },
          ],
        })
      );
      const result = runCli(
        ['--dir', dir, '--batch', 'queue-011', '--apply', '--replace-auth', authPath],
        {
          DATABASE_URL: url,
          UPLOADTHING_TOKEN: 'offline-test-token',
        }
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--replace-auth: нет записей для замены');
      expect(result.stdout).not.toContain('Preview:');
      expect(await db.emojiLibraryItem.count()).toBe(0);
    });

    it('replaces a category whose authorised original is isCustom false, and turns the mode on', async () => {
      await db.category.updateMany({
        where: { name: { in: replaceCells.map((c) => c.name) } },
        data: { isCustom: false },
      });
      const dir = await syntheticSheets(manifest);
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      const { results } = await importBatches(
        db,
        dir,
        batch,
        authFor(replaceCells, false),
        fakeUploader()
      );

      expect(results.map((r) => r.result.conflict)).toEqual(Array(5).fill(undefined));
      for (const cell of replaceCells) {
        const row = await db.category.findUniqueOrThrow({ where: { name: cell.name } });
        const library = await db.emojiLibraryItem.findUniqueOrThrow({
          where: { sourceRef: `queue-011#${cell.cell}` },
        });
        expect(row.isCustom).toBe(true);
        expect(row.imageUrl).toBe(library.imageUrl);
      }
    });

    it('leaves a mode switched off by hand alone when the old URL still matches', async () => {
      await db.category.update({ where: { name: 'Напитки' }, data: { isCustom: false } });
      const dir = await syntheticSheets(manifest);
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      const { results } = await importBatches(db, dir, batch, replaceAuth(), fakeUploader());

      const drinks = results.find((r) => r.cell.name === 'Напитки')!;
      expect(drinks.result.product).toBe('conflict');
      expect(drinks.result.conflict).toContain('не содержит ожидаемую старую картинку и режим');
      expect(
        await db.emojiLibraryItem.findUnique({ where: { sourceRef: 'queue-011#1' } })
      ).toBeNull();
      const row = await db.category.findUniqueOrThrow({ where: { name: 'Напитки' } });
      expect(row).toMatchObject({ imageUrl: OLD('Напитки'), isCustom: false });
    });

    it('keeps a mode switched off by hand while the run uploads, same URL', async () => {
      const dir = await syntheticSheets(manifest);
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      // The other writer switches the mode off for this category while this run uploads its picture.
      const upload = async (_image: Buffer, name: string) => {
        if (name === 'Напитки') {
          await db.category.update({ where: { name: 'Напитки' }, data: { isCustom: false } });
        }
        return `${UPLOADS}mode-race-${encodeURIComponent(name)}.webp`;
      };
      const { results } = await importBatches(db, dir, batch, replaceAuth(), upload);

      const drinks = results.find((r) => r.cell.name === 'Напитки')!;
      expect(drinks.result.product).toBe('conflict');
      expect(drinks.result.conflict).toContain('изменилась после проверки');
      const row = await db.category.findUniqueOrThrow({ where: { name: 'Напитки' } });
      expect(row).toMatchObject({ imageUrl: OLD('Напитки'), isCustom: false });
    });

    it('does not replay a finished replacement once its mode was switched off by hand', async () => {
      const dir = await syntheticSheets(manifest);
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      const first = await importBatches(db, dir, batch, replaceAuth(), fakeUploader());
      expect(first.results.filter((r) => r.result.product === 'conflict')).toEqual([]);

      await db.category.update({ where: { name: 'Напитки' }, data: { isCustom: false } });
      const { upload, names } = recordingUploader();
      const replay = await importBatches(db, dir, batch, replaceAuth(), upload);

      const drinks = replay.results.find((r) => r.cell.name === 'Напитки')!;
      expect(drinks.result.product).toBe('conflict');
      expect(names).not.toContain('Напитки');
      const row = await db.category.findUniqueOrThrow({ where: { name: 'Напитки' } });
      expect(row.isCustom).toBe(false);
    });

    it('refuses a null picture with no library record as a replay, before any upload or library write', async () => {
      await db.category.update({ where: { name: 'Напитки' }, data: { imageUrl: null } });
      const dir = await syntheticSheets(manifest);
      const batch = manifest.filter((b) => b.batch === 'queue-011');
      const { upload, names } = recordingUploader();
      const { results } = await importBatches(db, dir, batch, replaceAuth(), upload);

      const drinks = results.find((r) => r.cell.name === 'Напитки')!;
      expect(drinks.result.product).toBe('conflict');
      expect(drinks.result.conflict).toContain('не содержит ожидаемую старую картинку');
      expect(names).not.toContain('Напитки');
      expect(
        await db.emojiLibraryItem.findUnique({ where: { sourceRef: 'queue-011#1' } })
      ).toBeNull();
      expect(
        (await db.category.findUniqueOrThrow({ where: { name: 'Напитки' } })).imageUrl
      ).toBeNull();
    });
  }
);
