import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';
import {
  applyCell,
  cellRef,
  findBatchFiles,
  loadCatalogIndex,
  ownsLibraryItem,
  planProduct,
  readBatchImages,
  storedPictures,
  type CellPlan,
  type ManifestBatch,
  type ManifestCell,
  type ProductPlan,
  type StoredPicture,
} from '../src/lib/services/emoji-batch-import';

// Imports the operator's emoji sheets (AGE-1465 item 2, AGE-1667 queue).
//   npx tsx scripts/emoji-import.ts [--dir <folder>] [--batch 001,002,text-001,queue-001] [--out <folder>]
//   DATABASE_URL=... npx tsx scripts/emoji-import.ts ...            preview against the catalogue
//   DATABASE_URL=... UPLOADTHING_TOKEN=... npx tsx scripts/emoji-import.ts --apply ...
// Without --apply nothing is written: the normalized pictures and preview.html go to --out.
// DATABASE_URL is read from the environment only, never from .env.

const MANIFESTS = ['docs/emoji-batches/manifest.json', 'docs/emoji-batches/queue-manifest.json'];

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function expandHome(path: string) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type PreviewRow = {
  ref: string;
  name: string;
  nameEn: string;
  category: string;
  ru: string;
  en?: string;
  action: string;
  stored: boolean;
};

function previewHtml(rows: PreviewRow[], missing: string[], summary: string[]) {
  const tiles = (row: PreviewRow) =>
    [row.ru, row.en]
      .filter(Boolean)
      .map(
        (file) =>
          `<span class="pair"><img src="${file}" class="light"><img src="${file}" class="dark"></span>`
      )
      .join('');
  const body = rows
    .map(
      (row) => `<tr><td>${escapeHtml(row.ref)}</td><td>${tiles(row)}</td>
<td><b>${escapeHtml(row.name)}</b><br><small>${escapeHtml(row.nameEn)} · ${escapeHtml(row.category)}</small></td>
<td>${escapeHtml(row.action)}${row.stored ? '<br><small>уже в библиотеке — повторной загрузки не будет</small>' : ''}</td></tr>`
    )
    .join('\n');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Предпросмотр импорта emoji</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse}td{border-bottom:1px solid #ddd;padding:6px 10px;vertical-align:middle}
img{width:72px;height:72px;padding:6px;border-radius:12px}.light{background:#f3f4f6}.dark{background:#1f2937}.pair{display:inline-flex;gap:4px;margin-right:10px}</style>
</head><body><h1>Предпросмотр импорта emoji</h1>
<p>${rows.length} ячеек. ${missing.length ? `Нет файлов: ${missing.map(escapeHtml).join(', ')}.` : ''}</p>
${summary.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n')}
<table>${body}</table></body></html>`;
}

// What a cell will do, in words for the preview. Without a catalogue there is nothing to check.
function describeAction(cell: ManifestCell, product: ProductPlan | null) {
  if (cell.supersededBy) return `только в библиотеку: картинка товара — из ${cell.supersededBy}`;
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

function argumentBatches(value: string) {
  return value
    .split(',')
    .map((id) => (/^(batch|text|queue)-/.test(id) ? id : `batch-${id.padStart(3, '0')}`));
}

async function main() {
  const dir = resolve(expandHome(argument('--dir') ?? '~/Downloads/clickmoji-batches'));
  const out = resolve(expandHome(argument('--out') ?? join(dir, 'preview')));
  const only = argument('--batch') ? argumentBatches(argument('--batch')!) : undefined;
  const apply = process.argv.includes('--apply');

  if (apply && (!process.env.DATABASE_URL || !process.env.UPLOADTHING_TOKEN)) {
    throw new Error('--apply needs DATABASE_URL and UPLOADTHING_TOKEN in the environment');
  }

  const manifest = MANIFESTS.flatMap(
    (path) => JSON.parse(readFileSync(path, 'utf8')) as ManifestBatch[]
  );
  const batches = manifest.filter((batch) => !only || only.includes(batch.batch));
  const prisma = process.env.DATABASE_URL
    ? new PrismaClient({ adapter: createPrismaPgAdapter() })
    : null;

  mkdirSync(out, { recursive: true });
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

      const product = index ? planProduct(cell, index) : null;
      // A queue cell whose library record belongs to another target is refused at apply time.
      const owner = stored.get(ref);
      const clash = cell.target !== undefined && owner && !ownsLibraryItem(owner, cell);
      rows.push({
        ref,
        name: cell.name,
        nameEn: cell.nameEn,
        category: cell.category,
        ru: ruFile,
        en: enFile,
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
        });
      }
    }
  }

  const summary = index
    ? summarize(targets)
    : [`Целей: ${targets.length}; каталог не проверялся (нет DATABASE_URL).`];
  writeFileSync(join(out, 'preview.html'), previewHtml(rows, missing, summary));
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
