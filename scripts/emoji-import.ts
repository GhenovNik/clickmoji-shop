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
  planProduct,
  readBatchImages,
  storedPictures,
  type CellPlan,
  type ManifestBatch,
} from '../src/lib/services/emoji-batch-import';

// Imports the operator's emoji sheets (AGE-1465 item 2).
//   npx tsx scripts/emoji-import.ts [--dir <folder>] [--batch 001,002,text-001] [--out <folder>]
//   DATABASE_URL=... npx tsx scripts/emoji-import.ts ...            preview against the catalogue
//   DATABASE_URL=... UPLOADTHING_TOKEN=... npx tsx scripts/emoji-import.ts --apply ...
// Without --apply nothing is written: the normalized pictures and preview.html go to --out.
// DATABASE_URL is read from the environment only, never from .env.

const MANIFEST = 'docs/emoji-batches/manifest.json';

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

function previewHtml(rows: PreviewRow[], missing: string[]) {
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
<table>${body}</table></body></html>`;
}

async function main() {
  const dir = resolve(expandHome(argument('--dir') ?? '~/Downloads/clickmoji-batches'));
  const out = resolve(expandHome(argument('--out') ?? join(dir, 'preview')));
  const only = argument('--batch')
    ?.split(',')
    .map((id) => (/^(batch|text)-/.test(id) ? id : `batch-${id.padStart(3, '0')}`));
  const apply = process.argv.includes('--apply');

  if (apply && (!process.env.DATABASE_URL || !process.env.UPLOADTHING_TOKEN)) {
    throw new Error('--apply needs DATABASE_URL and UPLOADTHING_TOKEN in the environment');
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestBatch[];
  const batches = manifest.filter((batch) => !only || only.includes(batch.batch));
  const prisma = process.env.DATABASE_URL
    ? new PrismaClient({ adapter: createPrismaPgAdapter() })
    : null;

  mkdirSync(out, { recursive: true });
  const index = prisma ? await loadCatalogIndex(prisma) : null;
  const plans: CellPlan[] = [];
  const rows: PreviewRow[] = [];
  const missing: string[] = [];

  for (const batch of batches) {
    const files = findBatchFiles(dir, batch.batch);
    if (!files.sheet && files.cells.size === 0) {
      if (only) missing.push(batch.batch);
      continue;
    }
    const images = await readBatchImages(batch, files, (path) => readFileSync(path));
    const refs = batch.cells.map((cell) => cellRef(batch.batch, cell.cell));
    const stored = prisma ? await storedPictures(prisma, refs) : new Map<string, string>();

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
      const action = cell.supersededBy
        ? `только в библиотеку: картинка товара — из ${cell.supersededBy}`
        : !product
          ? cell.action === 'create'
            ? 'создать товар (по манифесту; каталог не проверялся)'
            : 'картинка для существующего товара (по манифесту)'
          : product.kind === 'link'
            ? `привязать к товару «${product.productName}»`
            : product.kind === 'create'
              ? `создать товар в «${cell.category}»`
              : product.kind === 'superseded'
                ? `только в библиотеку: картинка товара — из ${product.by}`
                : `только в библиотеку: нет категории «${cell.category}»`;
      rows.push({
        ref,
        name: cell.name,
        nameEn: cell.nameEn,
        category: cell.category,
        ru: ruFile,
        en: enFile,
        action,
        stored: stored.has(ref),
      });
      if (product) {
        plans.push({
          ref,
          batch: batch.batch,
          batchKind: batch.kind ?? 'universal',
          cell,
          images: picture,
          stored: { ru: stored.get(ref), en: stored.get(`${ref}:en`) },
          product,
        });
      }
    }
  }

  writeFileSync(join(out, 'preview.html'), previewHtml(rows, missing));
  console.log(`Preview: ${join(out, 'preview.html')} (${rows.length} cells)`);
  if (missing.length) console.log(`Missing: ${missing.join(', ')}`);

  if (apply && prisma) {
    const { uploadNormalizedEmojiImage } = await import('../src/lib/services/emoji-assets');
    const upload = async (image: Buffer, name: string) =>
      (await uploadNormalizedEmojiImage({ imageBuffer: image, productName: name })).imageUrl;
    let uploaded = 0;
    for (const plan of plans) {
      const result = await applyCell(prisma, plan, upload);
      uploaded += result.uploaded;
      const target =
        result.product === 'linked'
          ? `→ ${result.productName}`
          : result.product === 'created'
            ? '→ новый товар'
            : result.product === 'superseded'
              ? '→ только библиотека (перерисован в текстовой пачке)'
              : '→ только библиотека';
      console.log(
        `${result.ref} ${result.name} ${target}${result.uploaded ? '' : ' (без загрузки)'}`
      );
    }
    console.log(`Applied ${plans.length} cells, uploaded ${uploaded} files.`);
  } else if (apply) {
    console.log('Nothing applied.');
  }

  await prisma?.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
