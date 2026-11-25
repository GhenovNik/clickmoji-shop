// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { previewHtml, type PreviewRow } from '../../../scripts/emoji-import';
import { runAuditCli } from '../../../scripts/emoji-detail-audit';
import { readBatchImages, type ManifestBatch } from './emoji-batch-import';
import {
  DEFAULT_DETAIL_THRESHOLD_BYTES,
  assertPathOutsideRepo,
  auditCatalogImages,
  cacheKeyForUrl,
  createCachingImageLoader,
  detailScoreFromNormalized,
  formatCatalogAuditMarkdown,
  isDetailAboveThreshold,
  loadStyleRefs,
  measureEmojiDetail,
  parseCatalogExport,
  parseDetailThreshold,
} from './emoji-detail';

const REPO_ROOT = process.cwd();
const TSX_CLI = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const IMPORT_CLI = resolve(REPO_ROOT, 'scripts/emoji-import.ts');
const AUDIT_CLI = resolve(REPO_ROOT, 'scripts/emoji-detail-audit.ts');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function smoothCirclePng(): Promise<Buffer> {
  return sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#ffffff"/><circle cx="64" cy="64" r="44" fill="#43a047"/></svg>'
    )
  )
    .png()
    .toBuffer();
}

// High-frequency coloured checkerboard/stripes produce a strictly larger WebP than a smooth circle.
async function detailedPatternPng(): Promise<Buffer> {
  const cells: string[] = [];
  for (let y = 16; y < 112; y += 4) {
    for (let x = 16; x < 112; x += 4) {
      const hue = (((x * 13 + y * 29) % 360) + 360) % 360;
      const light = 35 + ((x + y) % 40);
      cells.push(`<rect x="${x}" y="${y}" width="4" height="4" fill="hsl(${hue},80%,${light}%)"/>`);
    }
  }
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#ffffff"/>${cells.join('')}</svg>`
    )
  )
    .png()
    .toBuffer();
}

describe('emoji detail metric and strict threshold (AGE-1667 C3)', () => {
  it('validates configurable integer thresholds and rejects invalid values', () => {
    expect(parseDetailThreshold(undefined)).toBe(DEFAULT_DETAIL_THRESHOLD_BYTES);
    expect(parseDetailThreshold('0')).toBe(0);
    expect(parseDetailThreshold(' 14000 ')).toBe(14_000);
    for (const bad of ['', '-1', '12.5', 'abc', '1e4', 'Infinity']) {
      expect(() => parseDetailThreshold(bad), bad).toThrow('Invalid detail threshold');
    }
  });

  it('flags strictly above the threshold: equal and below are not flagged', () => {
    const threshold = 14_000;
    expect(isDetailAboveThreshold(threshold - 1, threshold)).toBe(false);
    expect(isDetailAboveThreshold(threshold, threshold)).toBe(false);
    expect(isDetailAboveThreshold(threshold + 1, threshold)).toBe(true);
  });

  // Image processing exceeded the default 5s in the full check.
  it(
    'scores a detailed patterned image strictly higher than a smooth shape',
    { timeout: 20_000 },
    async () => {
      const smooth = await measureEmojiDetail(await smoothCirclePng());
      const detailed = await measureEmojiDetail(await detailedPatternPng());
      expect(smooth.bytes).toBeGreaterThan(0);
      expect(detailed.bytes).toBeGreaterThan(smooth.bytes);
    }
  );

  it('rejects empty buffers', async () => {
    expect(() => detailScoreFromNormalized(Buffer.alloc(0))).toThrow('empty');
    await expect(measureEmojiDetail(Buffer.alloc(0))).rejects.toThrow('empty');
  });

  it(
    'loads all four checked-in style references below the default threshold',
    { timeout: 30_000 },
    async () => {
      const refs = await loadStyleRefs();
      expect(refs.map((r) => r.filename)).toEqual([
        'zucchini.webp',
        'lentils.webp',
        'honey.webp',
        'kefir.webp',
      ]);
      for (const ref of refs) {
        expect(ref.detailScore).toBeGreaterThan(0);
        expect(isDetailAboveThreshold(ref.detailScore, DEFAULT_DETAIL_THRESHOLD_BYTES)).toBe(false);
      }
    }
  );
});

describe('two-path consistency and preview rendering (AGE-1667 C3)', () => {
  it(
    'produces the exact same detail score via batch import and standalone measurement',
    { timeout: 30_000 },
    async () => {
      const smoothPng = await smoothCirclePng();
      const detailedPng = await detailedPatternPng();
      const dir = makeTempDir('c3-two-paths-');
      writeFileSync(join(dir, 'batch-001-1.png'), smoothPng);
      writeFileSync(join(dir, 'batch-001-2.png'), detailedPng);

      const manifest = JSON.parse(
        readFileSync('docs/emoji-batches/manifest.json', 'utf8')
      ) as ManifestBatch[];
      const batch001 = manifest.find((b) => b.batch === 'batch-001')!;
      const slicedBatch: ManifestBatch = {
        ...batch001,
        cells: batch001.cells.slice(0, 2),
      };

      // Path 1: batch import normalization.
      const batchImages = await readBatchImages(
        slicedBatch,
        {
          cells: new Map([
            [1, { ru: join(dir, 'batch-001-1.png') }],
            [2, { ru: join(dir, 'batch-001-2.png') }],
          ]),
        },
        (p) => readFileSync(p)
      );
      const importScore1 = detailScoreFromNormalized(batchImages.get(1)!.ru);
      const importScore2 = detailScoreFromNormalized(batchImages.get(2)!.ru);

      // Path 2: standalone detail measurement / catalogue audit on the same source images.
      const direct1 = await measureEmojiDetail(smoothPng);
      const direct2 = await measureEmojiDetail(detailedPng);
      expect(importScore1).toBe(direct1.bytes);
      expect(importScore2).toBe(direct2.bytes);

      // Also run the real scripts/emoji-import.ts CLI offline and confirm preview.html matches.
      const outDir = makeTempDir('c3-import-out-');
      const cli = spawnSync(
        process.execPath,
        [
          TSX_CLI,
          IMPORT_CLI,
          '--dir',
          dir,
          '--batch',
          '001',
          '--out',
          outDir,
          '--detail-threshold',
          String(importScore1),
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      expect(cli.status, cli.stderr).toBe(0);
      const html = readFileSync(join(outDir, 'preview.html'), 'utf8');

      // Top section shows all four style references and their scores.
      for (const file of [
        'style-ref-zucchini.webp',
        'style-ref-lentils.webp',
        'style-ref-honey.webp',
        'style-ref-kefir.webp',
      ]) {
        expect(html).toContain(file);
        expect(existsSync(join(outDir, file))).toBe(true);
      }
      // Both 56px and large images appear alongside exact detail scores.
      expect(html).toContain('class="img-56 light"');
      expect(html).toContain('class="img-lg light"');
      expect(html).toContain(`детальность <b>${importScore1} Б</b>`);
      expect(html).toContain(`детальность <b>${importScore2} Б</b>`);
      // Boundary: score === threshold is NOT flagged; score > threshold IS flagged.
      expect(html).not.toContain(
        `детальность <b>${importScore1} Б</b> <span class="badge-outlier">`
      );
      expect(html).toContain(
        `детальность <b>${importScore2} Б</b> <span class="badge-outlier">выше порога (&gt; ${importScore1} Б)</span>`
      );
      // Existing summary and import preview info stay intact.
      expect(cli.stdout).toContain(
        'Целей: 9; каталог не проверялся (C3 preview-only; сверка — --check-catalog).'
      );
      expect(cli.stdout).toContain(`Детальность (байты WebP, порог > ${importScore1} Б):`);
    }
  );

  it(
    'renders boundary equality and both sides accurately in previewHtml',
    { timeout: 30_000 },
    async () => {
      const styleRefs = await loadStyleRefs();
      const row = (ref: string, ruDetail: number): PreviewRow => ({
        ref,
        name: ref,
        nameEn: ref,
        category: 'Овощи',
        ru: `${ref}.webp`,
        ruDetail,
        action: 'картинка для существующего товара (по манифесту)',
        stored: false,
      });
      const threshold = 10_000;
      const html = previewHtml(
        [row('below', threshold - 1), row('equal', threshold), row('above', threshold + 1)],
        [],
        ['Целей: 3'],
        { styleRefs, threshold }
      );
      expect(html).not.toContain(
        `детальность <b>${threshold - 1} Б</b> <span class="badge-outlier">`
      );
      expect(html).not.toContain(`детальность <b>${threshold} Б</b> <span class="badge-outlier">`);
      expect(html).toContain(
        `детальность <b>${threshold + 1} Б</b> <span class="badge-outlier">выше порога (&gt; ${threshold} Б)</span>`
      );
    }
  );
});

describe('catalogue export audit without database or network (AGE-1667 C3)', () => {
  it('parses products vs all slots and rejects malformed exports', () => {
    const sample = {
      source: 'test export',
      categories: [
        {
          name: 'Овощи',
          nameEn: 'Vegetables',
          imageUrl: 'https://example.test/cat.webp',
          products: [
            {
              id: 'p1',
              name: 'Морковь',
              nameEn: 'Carrot',
              imageUrl: 'https://example.test/p1.webp',
              imageUrlEn: 'https://example.test/p1-en.webp',
              variants: [
                {
                  id: 'v1',
                  name: 'Морковь мытая',
                  nameEn: 'Washed carrot',
                  imageUrl: 'https://example.test/v1.webp',
                },
              ],
            },
            {
              name: 'Лук',
              nameEn: 'Onion',
              imageUrl: null,
              imageUrlEn: null,
              variants: [],
            },
          ],
        },
      ],
    };

    const productsOnly = parseCatalogExport(sample, 'products');
    expect(productsOnly.entries).toHaveLength(1);
    expect(productsOnly.entries[0]).toMatchObject({ id: 'p1', kind: 'product', field: 'imageUrl' });
    expect(productsOnly.counts).toEqual({
      categories: 1,
      products: 2,
      variants: 1,
      productPrimary: 1,
      productEn: 1,
      variantPrimary: 1,
      variantEn: 0,
      categoryPrimary: 1,
      totalSlots: 4,
    });

    const allSlots = parseCatalogExport(sample, 'all');
    expect(allSlots.entries).toHaveLength(4);

    expect(() => parseCatalogExport([])).toThrow('top-level JSON object');
    expect(() => parseCatalogExport({})).toThrow('missing "categories" array');
    expect(() => parseCatalogExport({ categories: [{ name: '', products: [] }] })).toThrow(
      'missing string categories[0].name'
    );
  });

  it('refuses cache or output paths inside the repository', () => {
    expect(() => assertPathOutsideRepo(REPO_ROOT, REPO_ROOT)).toThrow('inside repository');
    expect(() => assertPathOutsideRepo(join(REPO_ROOT, 'tmp-cache'), REPO_ROOT)).toThrow(
      'inside repository'
    );
    const out = makeTempDir('c3-outside-');
    expect(() => assertPathOutsideRepo(out, REPO_ROOT)).not.toThrow();
  });

  it(
    'sorts outliers deterministically and accounts for unknowns with non-zero CLI exit',
    { timeout: 30_000 },
    async () => {
      const smoothPng = await smoothCirclePng();
      const detailedPng = await detailedPatternPng();
      const smoothScore = (await measureEmojiDetail(smoothPng)).bytes;
      const detailedScore = (await measureEmojiDetail(detailedPng)).bytes;

      const exportDir = makeTempDir('c3-export-');
      const cacheDir = makeTempDir('c3-cache-');
      const outDir = makeTempDir('c3-audit-out-');

      const urlSmooth = 'https://cdn.example.test/smooth.png';
      const urlEqual = 'https://cdn.example.test/equal.png';
      const urlDetailed = 'https://cdn.example.test/detailed.png';
      const urlMissing = 'https://cdn.example.test/missing-404.png';

      writeFileSync(join(cacheDir, cacheKeyForUrl(urlSmooth)), smoothPng);
      writeFileSync(join(cacheDir, cacheKeyForUrl(urlEqual)), smoothPng);
      writeFileSync(join(cacheDir, cacheKeyForUrl(urlDetailed)), detailedPng);
      // urlMissing intentionally omitted from offline cache.

      const exportPath = join(exportDir, 'catalog.json');
      writeFileSync(
        exportPath,
        JSON.stringify({
          categories: [
            {
              name: 'Овощи',
              nameEn: 'Vegetables',
              products: [
                { id: 'p-smooth', name: 'Кабачок', nameEn: 'Zucchini', imageUrl: urlSmooth },
                { id: 'p-equal', name: 'Тыква', nameEn: 'Pumpkin', imageUrl: urlEqual },
                { id: 'p-det', name: 'Укроп', nameEn: 'Dill', imageUrl: urlDetailed },
                { id: 'p-miss', name: 'Сметана', nameEn: 'Sour Cream', imageUrl: urlMissing },
              ],
            },
          ],
        })
      );

      // Threshold equals smoothScore: only detailedScore (> smoothScore) is an outlier; missing is UNKNOWN.
      const exitIncomplete = await runAuditCli([
        '--input',
        exportPath,
        '--cache-dir',
        cacheDir,
        '--out',
        outDir,
        '--offline',
        '--detail-threshold',
        String(smoothScore),
      ]);
      expect(exitIncomplete).toBe(1);

      const report = JSON.parse(readFileSync(join(outDir, 'detail-report.json'), 'utf8'));
      expect(report.selectedTotal).toBe(4);
      expect(report.measuredCount).toBe(3);
      expect(report.unknownCount).toBe(1);
      expect(report.measuredCount + report.unknownCount).toBe(report.selectedTotal);
      expect(report.complete).toBe(false);
      expect(report.outliers).toHaveLength(1);
      expect(report.outliers[0]).toMatchObject({
        id: 'p-det',
        name: 'Укроп',
        detailScore: detailedScore,
        url: urlDetailed,
      });
      expect(report.unknowns[0]).toMatchObject({
        id: 'p-miss',
        name: 'Сметана',
        status: 'UNKNOWN',
        url: urlMissing,
      });
      const md = readFileSync(join(outDir, 'detail-report.md'), 'utf8');
      expect(md).toContain('Сметана');
      expect(md).toContain('Укроп');

      // Now supply the missing file -> complete run exits 0.
      writeFileSync(join(cacheDir, cacheKeyForUrl(urlMissing)), detailedPng);
      const cliComplete = spawnSync(
        process.execPath,
        [
          TSX_CLI,
          AUDIT_CLI,
          '--input',
          exportPath,
          '--cache-dir',
          cacheDir,
          '--out',
          outDir,
          '--offline',
          '--detail-threshold',
          String(smoothScore),
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      expect(cliComplete.status).toBe(0);
      expect(cliComplete.stdout).toContain('measured=4, unknown=0, outliers=2');
    }
  );

  it(
    'handles HTTP errors and corrupt images as UNKNOWN without crashing',
    { timeout: 30_000 },
    async () => {
      const cacheDir = makeTempDir('c3-loader-');
      const styleRefs = await loadStyleRefs();
      const { entries, counts } = parseCatalogExport({
        categories: [
          {
            name: 'Овощи',
            nameEn: 'Vegetables',
            products: [
              {
                name: 'Битый',
                nameEn: 'Corrupt',
                imageUrl: 'https://cdn.example.test/corrupt.png',
              },
              { name: 'Нет404', nameEn: 'Missing', imageUrl: 'https://cdn.example.test/404.png' },
            ],
          },
        ],
      });

      const loadImage = createCachingImageLoader({
        cacheDir,
        fetchImpl: async (url) => {
          if (String(url).includes('404')) {
            return new Response('Not found', { status: 404 });
          }
          return new Response(Buffer.from('not-an-image'), { status: 200 });
        },
      });

      const report = await auditCatalogImages({
        entries,
        counts,
        scope: 'products',
        threshold: DEFAULT_DETAIL_THRESHOLD_BYTES,
        styleRefs,
        loadImage,
      });

      expect(report.complete).toBe(false);
      expect(report.measuredCount).toBe(0);
      expect(report.unknownCount).toBe(2);
      expect(report.unknowns.map((u) => u.name)).toEqual(['Битый', 'Нет404']);
      expect(report.unknowns.find((u) => u.name === 'Нет404')?.reason).toContain('HTTP 404');
      expect(formatCatalogAuditMarkdown(report)).toContain('HTTP 404');
    }
  );
});
