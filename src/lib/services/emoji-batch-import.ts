import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { normalizeEmojiImage } from '@/lib/services/emoji-image-normalize';

// Batch import (AGE-1465 item 2): the operator's Gemini sheets (3 columns, cells left to right,
// top to bottom) plus docs/emoji-batches/manifest.json → normalized emoji in the library and on
// catalogue products. Every cell has a stable reference ("batch-007#3"), so a second run reuses
// what is stored instead of uploading again.

export type ManifestCell = {
  cell: number;
  category: string;
  name: string;
  nameEn: string;
  hint?: string;
  text?: boolean;
  action: 'create' | 'update-image';
  // The product's picture now comes from this text-batch cell; this one stays in the library.
  supersededBy?: string;
};

// universal: one text-free picture for every language; text: a Russian and an English sheet.
export type BatchKind = 'universal' | 'text';

export type ManifestBatch = {
  batch: string;
  kind?: BatchKind;
  file: string;
  fileEn?: string;
  cells: ManifestCell[];
};

export type BatchFiles = {
  sheet?: string;
  sheetEn?: string;
  // Single re-generated cells: batch-007-3.png and batch-007-3-en.png.
  cells: Map<number, { ru?: string; en?: string }>;
};

export type CellImages = { ru: Buffer; en?: Buffer };

export type ProductPlan =
  | { kind: 'link'; productId: string; productName: string }
  | { kind: 'create'; categoryId: string; categoryEmoji: string }
  | { kind: 'no-category' }
  | { kind: 'superseded'; by: string }
  // Several catalogue products share the name: nothing is linked, the operator decides.
  | { kind: 'ambiguous'; productNames: string[] };

export type CellPlan = {
  ref: string;
  batch: string;
  batchKind: BatchKind;
  cell: ManifestCell;
  images: CellImages;
  stored: { ru?: string; en?: string };
  product: ProductPlan;
};

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const COLUMNS = 3;

export function cellRef(batch: string, cell: number) {
  return `${batch}#${cell}`;
}

export function normalizeCatalogName(value: string) {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

export function findBatchFiles(dir: string, batch: string): BatchFiles {
  const files: BatchFiles = { cells: new Map() };
  if (!existsSync(dir)) return files;

  for (const name of readdirSync(dir)) {
    const lower = name.toLowerCase();
    const extension = IMAGE_EXTENSIONS.find((ext) => lower.endsWith(ext));
    if (!extension || !lower.startsWith(`${batch}`)) continue;
    const stem = lower.slice(0, -extension.length);
    const path = join(dir, name);

    if (stem === batch) files.sheet = path;
    else if (stem === `${batch}-en`) files.sheetEn = path;
    else {
      const match = stem.slice(batch.length).match(/^-(\d+)(-en)?$/);
      if (!match) continue;
      const cell = Number(match[1]);
      const entry = files.cells.get(cell) ?? {};
      if (match[2]) entry.en = path;
      else entry.ru = path;
      files.cells.set(cell, entry);
    }
  }
  return files;
}

// Cuts a sheet into `count` cells: three columns, as many rows as the cells need.
export async function sliceSheet(sheet: Buffer, count: number) {
  const { width = 0, height = 0 } = await sharp(sheet).metadata();
  const rows = Math.ceil(count / COLUMNS);
  const cells: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / COLUMNS);
    const column = i % COLUMNS;
    const left = Math.round((column * width) / COLUMNS);
    const top = Math.round((row * height) / rows);
    const right = Math.round(((column + 1) * width) / COLUMNS);
    const bottom = Math.round(((row + 1) * height) / rows);
    cells.push(
      await sharp(sheet)
        .extract({ left, top, width: right - left, height: bottom - top })
        .png()
        .toBuffer()
    );
  }
  return cells;
}

// Normalized pictures per cell; a single cell file replaces that cell of the sheet.
export async function readBatchImages(
  batch: ManifestBatch,
  files: BatchFiles,
  read: (path: string) => Buffer
) {
  const count = batch.cells.length;
  // A text-free batch has one picture for every language: an English file is ignored.
  const english = batch.kind === 'text';
  const sheet = files.sheet ? await sliceSheet(read(files.sheet), count) : [];
  const sheetEn = english && files.sheetEn ? await sliceSheet(read(files.sheetEn), count) : [];
  const result = new Map<number, CellImages>();

  for (const cell of batch.cells) {
    const single = files.cells.get(cell.cell);
    const ruSource = single?.ru ? read(single.ru) : sheet[cell.cell - 1];
    if (!ruSource) continue;
    const enSource = english && single?.en ? read(single.en) : sheetEn[cell.cell - 1];
    // Text-free pictures carry no label by their prompt, so an enclosed white region there is a
    // gap between parts of the object; on labelled pictures it may be the label and stays.
    const options = { clearEnclosedGaps: !english };
    result.set(cell.cell, {
      ru: await normalizeEmojiImage(ruSource, options),
      en: enSource ? await normalizeEmojiImage(enSource, options) : undefined,
    });
  }
  return result;
}

type CatalogIndex = {
  products: Map<string, { id: string; name: string }[]>;
  categories: Map<string, { id: string; emoji: string }>;
};

export async function loadCatalogIndex(prisma: PrismaClient): Promise<CatalogIndex> {
  const [products, categories] = await Promise.all([
    prisma.product.findMany({ where: { isGlobal: true }, select: { id: true, name: true } }),
    prisma.category.findMany({ select: { id: true, name: true, emoji: true } }),
  ]);
  const byName = new Map<string, { id: string; name: string }[]>();
  for (const product of products) {
    const key = normalizeCatalogName(product.name);
    byName.set(key, [...(byName.get(key) ?? []), product]);
  }
  return {
    products: byName,
    categories: new Map(categories.map((c) => [normalizeCatalogName(c.name), c])),
  };
}

export function planProduct(cell: ManifestCell, index: CatalogIndex): ProductPlan {
  if (cell.supersededBy) return { kind: 'superseded', by: cell.supersededBy };
  const matches = index.products.get(normalizeCatalogName(cell.name)) ?? [];
  if (matches.length > 1) {
    return { kind: 'ambiguous', productNames: matches.map((product) => product.name) };
  }
  const [product] = matches;
  if (product) return { kind: 'link', productId: product.id, productName: product.name };
  const category = index.categories.get(normalizeCatalogName(cell.category));
  return category
    ? { kind: 'create', categoryId: category.id, categoryEmoji: category.emoji }
    : { kind: 'no-category' };
}

export async function storedPictures(prisma: PrismaClient, refs: string[]) {
  const items = await prisma.emojiLibraryItem.findMany({
    where: { sourceRef: { in: refs.flatMap((ref) => [ref, `${ref}:en`]) } },
    select: { sourceRef: true, imageUrl: true },
  });
  return new Map(items.map((item) => [item.sourceRef ?? '', item.imageUrl]));
}

export type Uploader = (image: Buffer, name: string) => Promise<string>;
// Removes a file uploaded in this run whose library record could not be written.
export type Discarder = (imageUrl: string) => Promise<void>;

export type AppliedCell = {
  ref: string;
  name: string;
  uploaded: number;
  product: 'linked' | 'created' | 'library-only' | 'superseded' | 'ambiguous';
  productName?: string;
};

// Writes one cell. Pictures already stored under the cell reference are reused, so a re-run
// uploads nothing and only re-links the product.
export async function applyCell(
  prisma: PrismaClient,
  plan: CellPlan,
  upload: Uploader,
  discard?: Discarder
): Promise<AppliedCell> {
  const { cell, ref, images } = plan;
  const textBatch = plan.batchKind === 'text';
  let uploaded = 0;

  const store = async (
    locale: 'ru' | 'en' | null,
    image: Buffer,
    sourceRef: string,
    existing?: string
  ) => {
    const imageUrl = existing ?? (await upload(image, locale === 'en' ? cell.nameEn : cell.name));
    const fresh = !existing;
    if (fresh) uploaded++;
    const data = {
      imageUrl,
      name: cell.name,
      nameEn: cell.nameEn,
      tags: [normalizeCatalogName(cell.category)],
      source: 'batch',
      locale,
      groupKey: ref,
    };
    try {
      await prisma.emojiLibraryItem.upsert({
        where: { sourceRef },
        create: { sourceRef, ...data },
        update: data,
      });
    } catch (error) {
      // Without its library record a fresh upload would be orphaned and uploaded again on the
      // next run, so it is removed before the error goes on.
      if (fresh && discard) await discard(imageUrl).catch(() => undefined);
      throw error;
    }
    return imageUrl;
  };

  const imageUrl = await store(textBatch ? 'ru' : null, images.ru, ref, plan.stored.ru);
  const imageUrlEn =
    textBatch && images.en ? await store('en', images.en, `${ref}:en`, plan.stored.en) : null;

  // A text-free picture serves both languages, so it clears a stale English one. A Russian
  // label imported before its English sheet leaves an English picture already stored alone.
  const picture = {
    isCustom: true,
    imageUrl,
    ...(imageUrlEn || !textBatch ? { imageUrlEn } : {}),
  };
  if (plan.product.kind === 'link') {
    await prisma.product.update({ where: { id: plan.product.productId }, data: picture });
    return {
      ref,
      name: cell.name,
      uploaded,
      product: 'linked',
      productName: plan.product.productName,
    };
  }
  if (plan.product.kind === 'create') {
    await prisma.product.create({
      data: {
        name: cell.name,
        nameEn: cell.nameEn,
        emoji: plan.product.categoryEmoji,
        categoryId: plan.product.categoryId,
        isGlobal: true,
        ...picture,
      },
    });
    return { ref, name: cell.name, uploaded, product: 'created' };
  }
  if (plan.product.kind === 'ambiguous') {
    return { ref, name: cell.name, uploaded, product: 'ambiguous' };
  }
  if (plan.product.kind === 'superseded') {
    return { ref, name: cell.name, uploaded, product: 'superseded' };
  }
  return { ref, name: cell.name, uploaded, product: 'library-only' };
}
