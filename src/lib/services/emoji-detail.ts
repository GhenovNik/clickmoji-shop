import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  NORMALIZED_EMOJI_SIZE,
  normalizeEmojiImage,
  type NormalizeEmojiOptions,
} from '@/lib/services/emoji-image-normalize';
import { assertAuditOutputPath, assertPathOutsideRepo } from '@/lib/services/safe-paths';

// Canonical detail metric for AGE-1667 C3: byte size of the 256×256 transparent WebP produced by
// normalizeEmojiImage (quality 82, effort 6, 86% object fill, Lanczos3). Detailed or noisy
// illustrations compress worse and produce larger WebP payloads than the simplified style refs.

export const DETAIL_METRIC_NAME = 'normalized-webp-bytes';
export const DETAIL_METRIC_UNIT = 'bytes';
export const DEFAULT_DETAIL_THRESHOLD_BYTES = 14_000;
export const DEFAULT_STYLE_REFS_DIR = 'docs/emoji-batches/style-refs';
export const DEFAULT_CATALOG_EXPORT_PATH =
  '~/.local/share/dev-harness/artifacts/clickmoji/catalog-export-2026-11-25.json';

export type StyleRefSpec = {
  id: string;
  filename: string;
  label: string;
  labelEn: string;
  sourceRef: string;
};

export const STYLE_REF_SPECS: readonly StyleRefSpec[] = [
  {
    id: 'zucchini',
    filename: 'zucchini.webp',
    label: 'Кабачок',
    labelEn: 'Zucchini',
    sourceRef: 'batch-001#1',
  },
  {
    id: 'lentils',
    filename: 'lentils.webp',
    label: 'Чечевица',
    labelEn: 'Lentils',
    sourceRef: 'batch-001#2',
  },
  {
    id: 'honey',
    filename: 'honey.webp',
    label: 'Мёд',
    labelEn: 'Honey',
    sourceRef: 'batch-010#4',
  },
  {
    id: 'kefir',
    filename: 'kefir.webp',
    label: 'Кефир',
    labelEn: 'Kefir',
    sourceRef: 'text-001#2',
  },
] as const;

export type StyleRefSample = StyleRefSpec & {
  outFile: string;
  rawBytes: number;
  detailScore: number;
  buffer: Buffer;
};

export function expandHomePath(value: string): string {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

export function parseDetailThreshold(
  raw: string | undefined,
  fallback = DEFAULT_DETAIL_THRESHOLD_BYTES
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid detail threshold "${raw}": expected a non-negative integer (bytes)`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid detail threshold "${raw}": expected a safe non-negative integer`);
  }
  return parsed;
}

// Strict comparison: equal to the threshold stays within bounds; only strictly higher values are flagged.
export function isDetailAboveThreshold(score: number, threshold: number): boolean {
  return score > threshold;
}

// Measures detail directly from an already-normalized WebP buffer produced by normalizeEmojiImage.
export function detailScoreFromNormalized(normalizedWebp: Buffer): number {
  if (normalizedWebp.byteLength === 0) {
    throw new Error('Cannot measure detail of an empty normalized buffer');
  }
  return normalizedWebp.byteLength;
}

// Runs the same canonical normalization used during batch import and returns the byte count.
export async function measureEmojiDetail(
  input: Buffer,
  options: NormalizeEmojiOptions = {}
): Promise<{ bytes: number; normalized: Buffer }> {
  if (input.byteLength === 0) {
    throw new Error('Cannot measure detail of an empty image buffer');
  }
  const normalized = await normalizeEmojiImage(input, options);
  return {
    bytes: detailScoreFromNormalized(normalized),
    normalized,
  };
}

export async function loadStyleRefs(
  styleRefsDir = DEFAULT_STYLE_REFS_DIR
): Promise<StyleRefSample[]> {
  const dir = resolve(expandHomePath(styleRefsDir));
  return Promise.all(
    STYLE_REF_SPECS.map(async (spec) => {
      const filePath = join(dir, spec.filename);
      if (!existsSync(filePath)) {
        throw new Error(`Missing style reference image: ${filePath}`);
      }
      const buffer = readFileSync(filePath);
      const { bytes } = await measureEmojiDetail(buffer);
      return {
        ...spec,
        outFile: `style-ref-${spec.filename}`,
        rawBytes: buffer.byteLength,
        detailScore: bytes,
        buffer,
      };
    })
  );
}

export type CatalogImageKind = 'product' | 'variant' | 'category';
export type CatalogImageField = 'imageUrl' | 'imageUrlEn';
export type CatalogAuditScope = 'products' | 'all';

export type CatalogImageEntry = {
  id?: string;
  kind: CatalogImageKind;
  field: CatalogImageField;
  category: string;
  parent?: string;
  name: string;
  nameEn: string;
  url: string;
};

export type CatalogExportCounts = {
  categories: number;
  products: number;
  variants: number;
  productPrimary: number;
  productEn: number;
  variantPrimary: number;
  variantEn: number;
  categoryPrimary: number;
  totalSlots: number;
};

type RawVariant = {
  id?: unknown;
  name?: unknown;
  nameEn?: unknown;
  imageUrl?: unknown;
  imageUrlEn?: unknown;
};

type RawProduct = {
  id?: unknown;
  name?: unknown;
  nameEn?: unknown;
  imageUrl?: unknown;
  imageUrlEn?: unknown;
  variants?: unknown;
};

type RawCategory = {
  id?: unknown;
  name?: unknown;
  nameEn?: unknown;
  imageUrl?: unknown;
  products?: unknown;
};

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid catalog export: ${label} must be string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid catalog export: missing string ${label}`);
  }
  return value;
}

export function parseCatalogExport(
  rawJson: unknown,
  scope: CatalogAuditScope = 'products'
): { entries: CatalogImageEntry[]; counts: CatalogExportCounts } {
  if (typeof rawJson !== 'object' || rawJson === null || Array.isArray(rawJson)) {
    throw new Error('Invalid catalog export: expected top-level JSON object');
  }
  const top = rawJson as { categories?: unknown };
  if (!Array.isArray(top.categories)) {
    throw new Error('Invalid catalog export: missing "categories" array');
  }

  const allSlots: CatalogImageEntry[] = [];
  const counts: CatalogExportCounts = {
    categories: 0,
    products: 0,
    variants: 0,
    productPrimary: 0,
    productEn: 0,
    variantPrimary: 0,
    variantEn: 0,
    categoryPrimary: 0,
    totalSlots: 0,
  };

  for (let ci = 0; ci < top.categories.length; ci++) {
    const rawCat = top.categories[ci] as RawCategory;
    if (typeof rawCat !== 'object' || rawCat === null || Array.isArray(rawCat)) {
      throw new Error(`Invalid catalog export: categories[${ci}] must be an object`);
    }
    counts.categories++;
    const catName = requiredString(rawCat.name, `categories[${ci}].name`);
    const catNameEn = optionalString(rawCat.nameEn, `categories[${ci}].nameEn`) ?? '';
    const catId = optionalString(rawCat.id, `categories[${ci}].id`) ?? undefined;
    const catImg = optionalString(rawCat.imageUrl, `categories[${ci}].imageUrl`);
    if (catImg) {
      counts.categoryPrimary++;
      allSlots.push({
        ...(catId ? { id: catId } : {}),
        kind: 'category',
        field: 'imageUrl',
        category: catName,
        name: catName,
        nameEn: catNameEn,
        url: catImg,
      });
    }

    if (!Array.isArray(rawCat.products)) {
      throw new Error(`Invalid catalog export: categories[${ci}].products must be an array`);
    }
    for (let pi = 0; pi < rawCat.products.length; pi++) {
      const rawProd = rawCat.products[pi] as RawProduct;
      if (typeof rawProd !== 'object' || rawProd === null || Array.isArray(rawProd)) {
        throw new Error(
          `Invalid catalog export: categories[${ci}].products[${pi}] must be an object`
        );
      }
      counts.products++;
      const prodName = requiredString(rawProd.name, `categories[${ci}].products[${pi}].name`);
      const prodNameEn =
        optionalString(rawProd.nameEn, `categories[${ci}].products[${pi}].nameEn`) ?? '';
      const prodId =
        optionalString(rawProd.id, `categories[${ci}].products[${pi}].id`) ?? undefined;
      const prodImg = optionalString(rawProd.imageUrl, `products[${pi}].imageUrl`);
      const prodImgEn = optionalString(rawProd.imageUrlEn, `products[${pi}].imageUrlEn`);

      if (prodImg) {
        counts.productPrimary++;
        allSlots.push({
          ...(prodId ? { id: prodId } : {}),
          kind: 'product',
          field: 'imageUrl',
          category: catName,
          name: prodName,
          nameEn: prodNameEn,
          url: prodImg,
        });
      }
      if (prodImgEn) {
        counts.productEn++;
        allSlots.push({
          ...(prodId ? { id: prodId } : {}),
          kind: 'product',
          field: 'imageUrlEn',
          category: catName,
          name: prodName,
          nameEn: prodNameEn,
          url: prodImgEn,
        });
      }

      if (rawProd.variants !== undefined) {
        if (!Array.isArray(rawProd.variants)) {
          throw new Error(`Invalid catalog export: products[${pi}].variants must be an array`);
        }
        for (let vi = 0; vi < rawProd.variants.length; vi++) {
          const rawVar = rawProd.variants[vi] as RawVariant;
          if (typeof rawVar !== 'object' || rawVar === null || Array.isArray(rawVar)) {
            throw new Error(`Invalid catalog export: variants[${vi}] must be an object`);
          }
          counts.variants++;
          const varName = requiredString(rawVar.name, `variants[${vi}].name`);
          const varNameEn = optionalString(rawVar.nameEn, `variants[${vi}].nameEn`) ?? '';
          const varId = optionalString(rawVar.id, `variants[${vi}].id`) ?? undefined;
          const varImg = optionalString(rawVar.imageUrl, `variants[${vi}].imageUrl`);
          const varImgEn = optionalString(rawVar.imageUrlEn, `variants[${vi}].imageUrlEn`);

          if (varImg) {
            counts.variantPrimary++;
            allSlots.push({
              ...(varId ? { id: varId } : {}),
              kind: 'variant',
              field: 'imageUrl',
              category: catName,
              parent: prodName,
              name: varName,
              nameEn: varNameEn,
              url: varImg,
            });
          }
          if (varImgEn) {
            counts.variantEn++;
            allSlots.push({
              ...(varId ? { id: varId } : {}),
              kind: 'variant',
              field: 'imageUrlEn',
              category: catName,
              parent: prodName,
              name: varName,
              nameEn: varNameEn,
              url: varImgEn,
            });
          }
        }
      }
    }
  }

  counts.totalSlots = allSlots.length;
  const entries =
    scope === 'all'
      ? allSlots
      : allSlots.filter((entry) => entry.kind === 'product' && entry.field === 'imageUrl');
  return { entries, counts };
}

export type MeasuredCatalogEntry = CatalogImageEntry & {
  detailScore: number;
  aboveThreshold: boolean;
  rawBytes: number;
  rawFormat: string;
  rawWidth: number;
  rawHeight: number;
};

export type UnknownCatalogEntry = CatalogImageEntry & {
  status: 'UNKNOWN';
  reason: string;
};

export type CatalogAuditReport = {
  metric: typeof DETAIL_METRIC_NAME;
  unit: typeof DETAIL_METRIC_UNIT;
  normalizedSize: number;
  threshold: number;
  scope: CatalogAuditScope;
  counts: CatalogExportCounts;
  selectedTotal: number;
  measuredCount: number;
  unknownCount: number;
  outlierCount: number;
  complete: boolean;
  styleRefs: Array<Omit<StyleRefSample, 'buffer' | 'outFile'>>;
  outliers: MeasuredCatalogEntry[];
  measured: MeasuredCatalogEntry[];
  unknowns: UnknownCatalogEntry[];
};

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortCatalogMeasured(entries: MeasuredCatalogEntry[]): MeasuredCatalogEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.detailScore - a.detailScore ||
      compareCodePoint(a.category, b.category) ||
      compareCodePoint(a.name, b.name) ||
      compareCodePoint(a.kind, b.kind) ||
      compareCodePoint(a.field, b.field) ||
      compareCodePoint(a.url, b.url)
  );
}

export function sortCatalogUnknowns(entries: UnknownCatalogEntry[]): UnknownCatalogEntry[] {
  return [...entries].sort(
    (a, b) =>
      compareCodePoint(a.category, b.category) ||
      compareCodePoint(a.name, b.name) ||
      compareCodePoint(a.kind, b.kind) ||
      compareCodePoint(a.field, b.field) ||
      compareCodePoint(a.url, b.url)
  );
}

export function cacheKeyForUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

export { assertPathOutsideRepo };

export type ImageLoader = (entry: CatalogImageEntry) => Promise<Buffer>;

export function createCachingImageLoader(options: {
  cacheDir: string;
  offline?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): ImageLoader {
  const { cacheDir, offline = false, timeoutMs = 15_000, fetchImpl = fetch } = options;
  assertPathOutsideRepo(cacheDir);
  mkdirSync(cacheDir, { recursive: true });

  return async (entry: CatalogImageEntry) => {
    const file = join(cacheDir, cacheKeyForUrl(entry.url));
    assertAuditOutputPath(file);
    if (existsSync(file)) {
      return readFileSync(file);
    }
    if (offline) {
      throw new Error(`Missing local cached copy (${file}) in offline mode`);
    }
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      throw new Error(`Invalid URL "${entry.url}"`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Unsupported URL protocol "${parsed.protocol}"`);
    }
    const response = await fetchImpl(entry.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new Error('Empty HTTP response body');
    }
    // The cache file may already exist as a link (even a dangling one): refuse before any write.
    assertAuditOutputPath(file);
    writeFileSync(file, buf);
    return buf;
  };
}

export async function auditCatalogImages(options: {
  entries: CatalogImageEntry[];
  counts: CatalogExportCounts;
  scope: CatalogAuditScope;
  threshold: number;
  styleRefs: StyleRefSample[];
  loadImage: ImageLoader;
  concurrency?: number;
}): Promise<CatalogAuditReport> {
  const { entries, counts, scope, threshold, styleRefs, loadImage, concurrency = 8 } = options;
  const measured: MeasuredCatalogEntry[] = [];
  const unknowns: UnknownCatalogEntry[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        const buffer = await loadImage(entry);
        const metadata = await sharp(buffer).metadata();
        const { bytes } = await measureEmojiDetail(buffer);
        measured.push({
          ...entry,
          detailScore: bytes,
          aboveThreshold: isDetailAboveThreshold(bytes, threshold),
          rawBytes: buffer.byteLength,
          rawFormat: metadata.format ?? 'unknown',
          rawWidth: metadata.width ?? 0,
          rawHeight: metadata.height ?? 0,
        });
      } catch (error) {
        unknowns.push({
          ...entry,
          status: 'UNKNOWN',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, entries.length || 1));
  await Promise.all(Array.from({ length: workerCount }, worker));

  const sortedMeasured = sortCatalogMeasured(measured);
  const outliers = sortedMeasured.filter((item) => item.aboveThreshold);
  const sortedUnknowns = sortCatalogUnknowns(unknowns);

  return {
    metric: DETAIL_METRIC_NAME,
    unit: DETAIL_METRIC_UNIT,
    normalizedSize: NORMALIZED_EMOJI_SIZE,
    threshold,
    scope,
    counts,
    selectedTotal: entries.length,
    measuredCount: sortedMeasured.length,
    unknownCount: sortedUnknowns.length,
    outlierCount: outliers.length,
    complete: sortedUnknowns.length === 0,
    styleRefs: styleRefs.map(({ buffer: _b, outFile: _o, ...meta }) => meta),
    outliers,
    measured: sortedMeasured,
    unknowns: sortedUnknowns,
  };
}

export function formatCatalogAuditMarkdown(report: CatalogAuditReport): string {
  const lines: string[] = [
    '# Отчёт детальности картинок каталога (AGE-1667 С3)',
    '',
    `- Метрика: \`${report.metric}\` (\`${report.unit}\`, ${report.normalizedSize}×${report.normalizedSize} WebP q=82 effort=6, fill=0.86)`,
    `- Порог: строго выше \`${report.threshold}\` Б (\`score > ${report.threshold}\`)`,
    `- Выборка: \`${report.scope}\` — выбрано ${report.selectedTotal} (в экспорте всего: ${report.counts.productPrimary} основных картинок товаров, ${report.counts.productEn} EN, ${report.counts.categoryPrimary} категорий, ${report.counts.variantPrimary} вариантов; итого ${report.counts.totalSlots} слотов)`,
    `- Измерено успешно: **${report.measuredCount}** из ${report.selectedTotal}`,
    `- Неизвестные / ошибки чтения: **${report.unknownCount}** (${report.complete ? 'полный результат' : 'неполный результат — ненулевой код возврата'})`,
    `- Выше порога (> ${report.threshold} Б): **${report.outlierCount}**`,
    '',
    '## Образцы стиля (`docs/emoji-batches/style-refs/`)',
    '',
    '| Образец | Файл | Исходный размер (Б) | Детальность после нормализации (Б) |',
    '|---|---|---|---|',
    ...report.styleRefs.map(
      (ref) =>
        `| ${ref.label} (${ref.labelEn}) | \`${ref.filename}\` | ${ref.rawBytes} | ${ref.detailScore} |`
    ),
    '',
    `## Картинки строго выше порога (> ${report.threshold} Б)`,
    '',
  ];

  if (report.outliers.length === 0) {
    lines.push('Нет измеренных картинок строго выше порога.', '');
  } else {
    lines.push(
      '| # | Название | English | Категория | Слот | Детальность (Б) | Исходник | URL / ID |',
      '|---|---|---|---|---|---|---|---|'
    );
    report.outliers.forEach((item, index) => {
      const slot =
        item.kind === 'variant'
          ? `variant (${item.parent ?? ''}) · ${item.field}`
          : `${item.kind} · ${item.field}`;
      const refId = item.id ? `${item.id} · ${item.url}` : item.url;
      lines.push(
        `| ${index + 1} | ${item.name} | ${item.nameEn} | ${item.category} | ${slot} | ${item.detailScore} | ${item.rawFormat} ${item.rawWidth}×${item.rawHeight} (${item.rawBytes} Б) | ${refId} |`
      );
    });
    lines.push('');
  }

  lines.push('## Неизвестные / ошибки чтения (UNKNOWN)', '');
  if (report.unknowns.length === 0) {
    lines.push('Ошибок чтения нет.', '');
  } else {
    lines.push(
      '| # | Название | English | Категория | Слот | Причина | URL / ID |',
      '|---|---|---|---|---|---|---|'
    );
    report.unknowns.forEach((item, index) => {
      const slot =
        item.kind === 'variant'
          ? `variant (${item.parent ?? ''}) · ${item.field}`
          : `${item.kind} · ${item.field}`;
      const refId = item.id ? `${item.id} · ${item.url}` : item.url;
      lines.push(
        `| ${index + 1} | ${item.name} | ${item.nameEn} | ${item.category} | ${slot} | ${item.reason} | ${refId} |`
      );
    });
    lines.push('');
  }

  return lines.join('\n');
}
