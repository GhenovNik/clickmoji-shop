import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_DETAIL_THRESHOLD_BYTES,
  DEFAULT_STYLE_REFS_DIR,
  STYLE_REF_SPECS,
  detailScoreFromNormalized,
  isDetailAboveThreshold,
  loadStyleRefs,
  parseDetailThreshold,
  type StyleRefSample,
} from '../src/lib/services/emoji-detail';
import { assertOutputsSeparate } from '../src/lib/services/safe-paths';
import {
  applyCell,
  cellRef,
  findBatchFiles,
  loadCatalogIndex,
  normalizeCatalogName,
  ownsLibraryItem,
  parseReplacementAuthorization,
  planProduct,
  readBatchImages,
  storedPictures,
  type CellPlan,
  type ManifestBatch,
  type ManifestCell,
  type ProductPlan,
  type StoredPicture,
} from '../src/lib/services/emoji-batch-import';

// Imports the operator's emoji sheets (AGE-1465 item 2, AGE-1667 queue, AGE-1667 C6 replacements).
//   npx tsx scripts/emoji-import.ts [--dir <folder>] [--batch 001,002,text-001,queue-001] [--out <folder>] [--detail-threshold <bytes>]
//       C3 preview-only: the catalogue is NOT opened, and an inherited DATABASE_URL is ignored.
//   DATABASE_URL=... npx tsx scripts/emoji-import.ts ... --check-catalog
//       opt-in C6 reconciliation with a local database; fails closed without DATABASE_URL.
//   DATABASE_URL=... UPLOADTHING_TOKEN=... npx tsx scripts/emoji-import.ts --apply ...   (implies --check-catalog)
//   ... --replace-auth <file.json>   the old URLs of the replaced categories (required for --apply)
// Without --apply nothing is written: the normalized pictures, style refs and preview.html go to --out.
// --out must be a different folder from --dir (also through a symlink or a hard link): sources are never overwritten.
// DATABASE_URL is read from the environment only, never from .env. The replacement file is never
// committed: it lists the picture URL the operator saw on each replaced category, see the README.

const MANIFESTS = ['docs/emoji-batches/manifest.json', 'docs/emoji-batches/queue-manifest.json'];

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Флаг ${name} требует значение`);
  }
  return value;
}

function expandHome(path: string) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export type PreviewRow = {
  ref: string;
  name: string;
  nameEn: string;
  category: string;
  ru: string;
  ruDetail: number;
  en?: string;
  enDetail?: number;
  action: string;
  stored: boolean;
};

export type PreviewRenderOptions = {
  styleRefs: StyleRefSample[];
  threshold: number;
};

function styleRefsSectionHtml(styleRefs: StyleRefSample[], threshold: number) {
  const cards = styleRefs
    .map(
      (ref) => `<div class="ref-card">
  <div class="ref-images">
    <span class="pair"><img src="${escapeHtml(ref.outFile)}" class="img-56 light" alt="${escapeHtml(ref.label)} 56px"><img src="${escapeHtml(ref.outFile)}" class="img-56 dark" alt="${escapeHtml(ref.label)} 56px dark"></span>
    <span class="pair"><img src="${escapeHtml(ref.outFile)}" class="img-lg light" alt="${escapeHtml(ref.label)} крупно"><img src="${escapeHtml(ref.outFile)}" class="img-lg dark" alt="${escapeHtml(ref.label)} крупно dark"></span>
  </div>
  <div class="ref-meta"><b>${escapeHtml(ref.label)}</b> <small>(${escapeHtml(ref.labelEn)})</small><br><small>${escapeHtml(ref.filename)} · ${escapeHtml(ref.sourceRef)}</small><br><span class="metric">детальность: <b>${ref.detailScore} Б</b></span></div>
</div>`
    )
    .join('\n');
  return `<section class="style-refs">
  <div class="style-refs-head">
    <h2>Образцы стиля (docs/emoji-batches/style-refs/)</h2>
    <p class="hint">Сравнение рядом с образцами: слева размер на телефоне (56 px), справа крупно (128 px). Порог детальности: строго выше <b>${threshold} Б</b> (нормализованный WebP 256×256 q=82).</p>
  </div>
  <div class="ref-grid">${cards}</div>
</section>`;
}

export function previewHtml(
  rows: PreviewRow[],
  missing: string[],
  summary: string[],
  options: PreviewRenderOptions = { styleRefs: [], threshold: DEFAULT_DETAIL_THRESHOLD_BYTES }
) {
  const { styleRefs, threshold } = options;
  const renderVariantTiles = (label: string | null, file: string) =>
    `<div class="variant-row">${label ? `<span class="lang-tag">${escapeHtml(label)}</span>` : ''}<span class="pair" title="56 px"><img src="${escapeHtml(file)}" class="img-56 light"><img src="${escapeHtml(file)}" class="img-56 dark"></span><span class="pair" title="крупно"><img src="${escapeHtml(file)}" class="img-lg light"><img src="${escapeHtml(file)}" class="img-lg dark"></span></div>`;

  const tiles = (row: PreviewRow) => {
    const parts = [renderVariantTiles(row.en ? 'RU' : null, row.ru)];
    if (row.en) parts.push(renderVariantTiles('EN', row.en));
    return parts.join('');
  };

  const detailCell = (row: PreviewRow) => {
    const ruAbove = isDetailAboveThreshold(row.ruDetail, threshold);
    const enAbove = row.enDetail !== undefined && isDetailAboveThreshold(row.enDetail, threshold);
    const items = [
      `<span class="metric">${row.en ? 'ru: ' : ''}детальность <b>${row.ruDetail} Б</b>${ruAbove ? ` <span class="badge-outlier">выше порога (&gt; ${threshold} Б)</span>` : ''}</span>`,
    ];
    if (row.enDetail !== undefined) {
      items.push(
        `<br><span class="metric">en: детальность <b>${row.enDetail} Б</b>${enAbove ? ` <span class="badge-outlier">выше порога (&gt; ${threshold} Б)</span>` : ''}</span>`
      );
    }
    return items.join('');
  };

  const body = rows
    .map((row) => {
      const outlier =
        isDetailAboveThreshold(row.ruDetail, threshold) ||
        (row.enDetail !== undefined && isDetailAboveThreshold(row.enDetail, threshold));
      return `<tr${outlier ? ' class="outlier"' : ''}><td>${escapeHtml(row.ref)}</td><td>${tiles(row)}</td>
<td><b>${escapeHtml(row.name)}</b><br><small>${escapeHtml(row.nameEn)} · ${escapeHtml(row.category)}</small><br>${detailCell(row)}</td>
<td>${escapeHtml(row.action)}${row.stored ? '<br><small>уже в библиотеке — повторной загрузки не будет</small>' : ''}</td></tr>`;
    })
    .join('\n');

  const refsBlock = styleRefs.length > 0 ? styleRefsSectionHtml(styleRefs, threshold) : '';

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Предпросмотр импорта emoji</title>
<style>body{font:14px system-ui;margin:16px;color:#111827}
h1{margin:0 0 8px}h2{margin:0 0 6px;font-size:16px}
.style-refs{background:#ffffff;border:1px solid #d1d5db;border-radius:12px;padding:12px 14px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.hint{margin:0 0 10px;color:#4b5563;font-size:13px}
.ref-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}
.ref-card{border:1px solid #e5e7eb;border-radius:10px;padding:8px 10px;background:#f9fafb;display:flex;flex-direction:column;gap:6px}
.ref-images{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.ref-meta{font-size:13px;line-height:1.35}
table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:8px 10px;vertical-align:middle}
tr.outlier{background:#fffbeb}
.variant-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:2px 0}
.lang-tag{font-size:11px;font-weight:700;padding:2px 5px;border-radius:4px;background:#e5e7eb;color:#374151}
.img-56{width:56px;height:56px;padding:4px;border-radius:10px;object-fit:contain}
.img-lg{width:128px;height:128px;padding:8px;border-radius:14px;object-fit:contain}
.light{background:#f3f4f6}.dark{background:#1f2937}
.pair{display:inline-flex;gap:4px;align-items:center}
.metric{display:inline-block;margin-top:4px;font-size:13px;color:#1f2937}
.badge-outlier{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#fef3c7;border:1px solid #f59e0b;color:#92400e;font-size:12px;font-weight:600}</style>
</head><body><h1>Предпросмотр импорта emoji</h1>
${refsBlock}
<p>${rows.length} ячеек. ${missing.length ? `Нет файлов: ${missing.map(escapeHtml).join(', ')}.` : ''}</p>
${summary.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n')}
<table>${body}</table></body></html>`;
}

// What a cell will do, in words for the preview. Without a catalogue there is nothing to check.
function describeAction(cell: ManifestCell, product: ProductPlan | null) {
  if (cell.supersededBy) return `только в библиотеку: картинка товара — из ${cell.supersededBy}`;
  if (cell.action === 'replace') {
    if (!product) return `замена картинки категории «${cell.name}» (каталог не проверялся)`;
    if (product.kind === 'category')
      return `замена картинки категории «${product.categoryName}»: записывается, только если категория всё ещё содержит старую картинку и флаг isCustom из --replace-auth; иначе конфликт, ничего не перезаписывается`;
  }
  if (!product) {
    if (cell.target === 'variant')
      return `привязать к варианту «${cell.name}» (каталог не проверялся)`;
    if (cell.target === 'category')
      return `привязать к категории «${cell.name}» (каталог не проверялся)`;
    return cell.action === 'create'
      ? 'создать товар (по манифесту; каталог не проверялся)'
      : 'картинка для существующего товара (по манифесту)';
  }
  switch (product.kind) {
    case 'link':
      return `привязать к товару «${product.productName}»`;
    case 'variant':
      return `привязать к варианту «${product.variantName}» товара «${product.productName}»`;
    case 'category':
      return `привязать к категории «${product.categoryName}»`;
    case 'create':
      return `создать товар в «${cell.category}»`;
    case 'superseded':
      return `только в библиотеку: картинка товара — из ${product.by}`;
    case 'ambiguous':
      return `только в библиотеку: несколько товаров с этим названием (${product.productNames.join(', ')}) — выберите в админке`;
    case 'ambiguous-variant':
      return `только в библиотеку: несколько вариантов «${cell.name}» у товара «${product.productName}» (${product.variantNames.join(', ')}) — выберите в админке`;
    case 'ambiguous-category':
      return `только в библиотеку: похожие названия категорий (${product.categoryNames.join(', ')}) — уточните каталог`;
    case 'not-found':
      return `только в библиотеку: не найдено — ${product.reason}`;
    case 'no-category':
      return `только в библиотеку: нет категории «${cell.category}»`;
  }
}

// Counts for the preview: every cell of the selected batches is a target, found or not.
function summarize(targets: { cell: ManifestCell; product: ProductPlan | null }[]) {
  const found = targets.filter(
    ({ product }) =>
      product?.kind === 'link' || product?.kind === 'variant' || product?.kind === 'category'
  );
  const notFound = targets.filter(({ product }) => product?.kind === 'not-found');
  const ambiguous = targets.filter(
    ({ product }) =>
      product?.kind === 'ambiguous' ||
      product?.kind === 'ambiguous-variant' ||
      product?.kind === 'ambiguous-category'
  );
  const lines = [
    `Целей: ${targets.length}; найдено в каталоге: ${found.length}; ненайденных: ${notFound.length}; неоднозначных: ${ambiguous.length}.`,
  ];
  for (const { cell, product } of notFound) {
    lines.push(
      `Не найдено: ${cell.target ?? 'product'} «${cell.name}» — ${(product as { reason: string }).reason}`
    );
  }
  for (const { cell, product } of ambiguous) {
    lines.push(`Неоднозначно: ${cell.name} — ${describeAction(cell, product)}`);
  }
  return lines;
}

// Replacement targets among the selected batches: each needs its authorised old URL to apply.
function replaceCount(batches: ManifestBatch[]) {
  return batches.reduce(
    (n, batch) => n + batch.cells.filter((c) => c.action === 'replace').length,
    0
  );
}

function argumentBatches(value: string) {
  return value
    .split(',')
    .map((id) => (/^(batch|text|queue)-/.test(id) ? id : `batch-${id.padStart(3, '0')}`));
}

// Every file the run may write, by its name inside --out, for the check before the first write.
function plannedOutputNames(batches: ManifestBatch[]) {
  const names = ['preview.html', ...STYLE_REF_SPECS.map((spec) => `style-ref-${spec.filename}`)];
  for (const batch of batches) {
    for (const cell of batch.cells) {
      names.push(`${batch.batch}-${cell.cell}.webp`, `${batch.batch}-${cell.cell}-en.webp`);
    }
  }
  return names;
}

// Opens the catalogue only when the operator asked for it (C6 reconciliation or --apply).
async function openCatalog(): Promise<PrismaClient> {
  const prismaModule = await import('@prisma/client');
  const { createPrismaPgAdapter } = await import('../src/lib/prisma-adapter');
  return new prismaModule.PrismaClient({ adapter: createPrismaPgAdapter() });
}

export async function main() {
  const dir = resolve(expandHome(argument('--dir') ?? '~/Downloads/clickmoji-batches'));
  const out = resolve(expandHome(argument('--out') ?? join(dir, 'preview')));
  const only = argument('--batch') ? argumentBatches(argument('--batch')!) : undefined;
  const apply = process.argv.includes('--apply');
  const checkCatalog = apply || process.argv.includes('--check-catalog');
  const threshold = parseDetailThreshold(argument('--detail-threshold'));
  const styleRefsDir = argument('--style-refs') ?? DEFAULT_STYLE_REFS_DIR;

  if (apply && (!process.env.DATABASE_URL || !process.env.UPLOADTHING_TOKEN)) {
    throw new Error('--apply needs DATABASE_URL and UPLOADTHING_TOKEN in the environment');
  }
  if (checkCatalog && !process.env.DATABASE_URL) {
    throw new Error(
      '--check-catalog needs DATABASE_URL in the environment (C3 preview-only does not read the catalogue)'
    );
  }

  const manifest = MANIFESTS.flatMap(
    (path) => JSON.parse(readFileSync(path, 'utf8')) as ManifestBatch[]
  );
  const batches = manifest.filter((batch) => !only || only.includes(batch.batch));

  // Before any read of a picture and before any write: the sources and every planned output stay apart.
  assertOutputsSeparate({
    inputDir: dir,
    outDir: out,
    inputFiles: STYLE_REF_SPECS.map((spec) =>
      join(resolve(expandHome(styleRefsDir)), spec.filename)
    ),
    outputNames: plannedOutputNames(batches),
  });

  // Checked before any file is read or uploaded: a replacement without an exact authorisation stops here.
  const authPath = argument('--replace-auth');
  let authorization: ReturnType<typeof parseReplacementAuthorization> | undefined;
  if (authPath) {
    const file = resolve(expandHome(authPath));
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`--replace-auth: ${file} не читается как JSON: ${(error as Error).message}`);
    }
    authorization = parseReplacementAuthorization(json, manifest, batches);
  } else if (apply && replaceCount(batches) > 0) {
    throw new Error(
      `--apply: ${replaceCount(batches)} замен(ы) картинок категорий требуют --replace-auth <файл> с прежним URL и флагом isCustom каждой категории (см. docs/emoji-batches/README.md)`
    );
  }
  const styleRefs = await loadStyleRefs(styleRefsDir);
  const prisma = checkCatalog ? await openCatalog() : null;
  if (!checkCatalog && process.env.DATABASE_URL) {
    console.log(
      'DATABASE_URL не читается в C3 preview-only: каталог не открыт. Сверка с каталогом — флагом --check-catalog.'
    );
  }

  mkdirSync(out, { recursive: true });
  for (const ref of styleRefs) {
    writeFileSync(join(out, ref.outFile), ref.buffer);
  }
  const index = prisma ? await loadCatalogIndex(prisma) : null;
  const plans: CellPlan[] = [];
  const rows: PreviewRow[] = [];
  const missing: string[] = [];
  const targets: { cell: ManifestCell; product: ProductPlan | null }[] = [];

  for (const batch of batches) {
    const files = findBatchFiles(dir, batch.batch);
    const refs = batch.cells.map((cell) => cellRef(batch.batch, cell.cell));
    // Every cell is a target, whether or not its picture is on disk yet.
    for (const cell of batch.cells) {
      targets.push({ cell, product: index ? planProduct(cell, index) : null });
    }
    if (!files.sheet && files.cells.size === 0) {
      if (only) missing.push(batch.batch);
      continue;
    }
    const images = await readBatchImages(batch, files, (path) => readFileSync(path));
    const stored = prisma ? await storedPictures(prisma, refs) : new Map<string, StoredPicture>();

    for (const cell of batch.cells) {
      const picture = images.get(cell.cell);
      const ref = cellRef(batch.batch, cell.cell);
      if (!picture) {
        missing.push(ref);
        continue;
      }
      const ruFile = `${batch.batch}-${cell.cell}.webp`;
      const enFile = picture.en ? `${batch.batch}-${cell.cell}-en.webp` : undefined;
      writeFileSync(join(out, ruFile), picture.ru);
      if (enFile && picture.en) writeFileSync(join(out, enFile), picture.en);

      const ruDetail = detailScoreFromNormalized(picture.ru);
      const enDetail = picture.en ? detailScoreFromNormalized(picture.en) : undefined;

      const product = index ? planProduct(cell, index) : null;
      const replacement =
        cell.action === 'replace' && authorization
          ? authorization.get(normalizeCatalogName(cell.name))
          : undefined;
      // A queue cell whose library record belongs to another target is refused at apply time.
      const owner = stored.get(ref);
      const clash = cell.target !== undefined && owner && !ownsLibraryItem(owner, cell);
      rows.push({
        ref,
        name: cell.name,
        nameEn: cell.nameEn,
        category: cell.category,
        ru: ruFile,
        ruDetail,
        en: enFile,
        enDetail,
        action: clash
          ? `конфликт: картинка записана для другой цели («${owner?.name}») — не будет записана`
          : describeAction(cell, product),
        stored: stored.has(ref),
      });
      if (product) {
        plans.push({
          ref,
          batch: batch.batch,
          batchKind: batch.kind ?? 'universal',
          cell,
          images: picture,
          stored: { ru: owner?.imageUrl, en: stored.get(`${ref}:en`)?.imageUrl },
          product,
          replacement,
        });
      }
    }
  }

  const summary = index
    ? summarize(targets)
    : [
        `Целей: ${targets.length}; каталог не проверялся (C3 preview-only; сверка — --check-catalog).`,
      ];
  const replaces = replaceCount(batches);
  if (replaces > 0) {
    summary.push(
      `Замен картинок категорий: ${replaces}; ${authorization ? 'старые URL проверены по --replace-auth' : 'без --replace-auth запись невозможна'}.`
    );
  }
  const scores = rows.flatMap((row) =>
    row.enDetail !== undefined ? [row.ruDetail, row.enDetail] : [row.ruDetail]
  );
  const aboveThreshold = scores.filter((score) => isDetailAboveThreshold(score, threshold)).length;
  summary.push(
    `Детальность (байты WebP, порог > ${threshold} Б): выше порога ${aboveThreshold} из ${scores.length} картинок.`
  );
  writeFileSync(
    join(out, 'preview.html'),
    previewHtml(rows, missing, summary, { styleRefs, threshold })
  );
  console.log(`Preview: ${join(out, 'preview.html')} (${rows.length} cells)`);
  for (const line of summary) console.log(line);
  if (missing.length) console.log(`Missing: ${missing.join(', ')}`);

  if (apply && prisma) {
    const { uploadNormalizedEmojiImage } = await import('../src/lib/services/emoji-assets');
    const { UTApi } = await import('uploadthing/server');
    const utapi = new UTApi();
    const upload = async (image: Buffer, name: string) =>
      (await uploadNormalizedEmojiImage({ imageBuffer: image, productName: name, utapi })).imageUrl;
    let uploaded = 0;
    let changed = 0;
    let conflicts = 0;
    for (const plan of plans) {
      const result = await applyCell(prisma, plan, upload);
      uploaded += result.uploaded;
      if (result.changed) changed++;
      if (result.product === 'conflict') conflicts++;
      const target =
        result.product === 'conflict'
          ? `→ конфликт: ${result.conflict}`
          : result.product === 'linked'
            ? `→ ${result.productName}`
            : result.product === 'variant' || result.product === 'category'
              ? `→ ${result.productName}`
              : result.product === 'created'
                ? '→ новый товар'
                : result.product === 'superseded'
                  ? '→ только библиотека (перерисован в текстовой пачке)'
                  : result.product === 'ambiguous'
                    ? '→ только библиотека (неоднозначное название или категория, уточните каталог)'
                    : result.product === 'ambiguous-variant'
                      ? '→ только библиотека (неоднозначный вариант, выберите в админке)'
                      : result.product === 'not-found'
                        ? '→ только библиотека (цель не найдена в каталоге)'
                        : '→ только библиотека';
      console.log(
        `${result.ref} ${result.name} ${target}${result.changed ? '' : ' (без изменений)'}${
          result.uploaded ? ` (загружено ${result.uploaded})` : ''
        }`
      );
    }
    console.log(
      `Applied ${plans.length} cells, uploaded ${uploaded} files, changed ${changed}, conflicts ${conflicts}.`
    );
  } else if (apply) {
    console.log('Nothing applied.');
  }

  await prisma?.$disconnect();
}

if (process.argv[1]?.endsWith('emoji-import.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
