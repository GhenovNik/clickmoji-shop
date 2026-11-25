import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EmojiLibraryItem, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { normalizeEmojiImage } from '@/lib/services/emoji-image-normalize';

// Batch import (AGE-1465 item 2): the operator's Gemini sheets (3 columns, cells left to right,
// top to bottom) plus docs/emoji-batches/manifest.json and queue-manifest.json → normalized emoji
// in the library and on catalogue records. Every cell has a stable reference ("batch-007#3"), so
// a second run reuses what is stored instead of uploading again, and writes nothing that is
// already in place.

// What a cell's picture is for. Historical batches (no `target`) mean a product.
export type ManifestTarget = 'product' | 'variant' | 'category';

export type ManifestCell = {
  cell: number;
  category: string;
  name: string;
  nameEn: string;
  hint?: string;
  text?: boolean;
  // Enclosed white regions were checked to be gaps between parts of the object.
  gaps?: boolean;
  action: 'create' | 'update-image';
  // The product's picture now comes from this text-batch cell; this one stays in the library.
  supersededBy?: string;
  target?: ManifestTarget;
  // Variant only: the name of its catalogue product. The variant is looked up under that product.
  parent?: string;
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
  | { kind: 'ambiguous'; productNames: string[] }
  // A queue target that is not in the catalogue: nothing is created, the picture stays in the library.
  | { kind: 'not-found'; reason: string }
  | { kind: 'variant'; variantId: string; productName: string; variantName: string }
  | { kind: 'ambiguous-variant'; productName: string; variantNames: string[] }
  | { kind: 'category'; categoryId: string; categoryName: string };

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

// Cuts a sheet into `count` cells: three columns of square cells, left to right, top to bottom.
// The row count follows the sheet's shape, not the cell count: a square sheet is always 3 × 3, so
// a short batch takes its cells from the top and anything drawn below them is ignored.
export async function sliceSheet(sheet: Buffer, count: number) {
  const { width = 0, height = 0 } = await sharp(sheet).metadata();
  const rows = Math.max(
    Math.ceil(count / COLUMNS),
    Math.round((height * COLUMNS) / Math.max(width, 1))
  );
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
    // Gap clearing removes enclosed white regions; it runs only for cells whose gaps were checked
    // and never for a labelled product, whose white region may be its label.
    const options = { clearEnclosedGaps: Boolean(cell.gaps) && !cell.text && !english };
    result.set(cell.cell, {
      ru: await normalizeEmojiImage(ruSource, options),
      en: enSource ? await normalizeEmojiImage(enSource, options) : undefined,
    });
  }
  return result;
}

type CatalogIndex = {
  // Global products by normalized name.
  products: Map<string, { id: string; name: string }[]>;
  // Variants of global products, by product id.
  variants: Map<string, { id: string; name: string }[]>;
  categories: Map<string, { id: string; name: string; emoji: string }>;
};

export async function loadCatalogIndex(prisma: PrismaClient): Promise<CatalogIndex> {
  const [products, variants, categories] = await Promise.all([
    prisma.product.findMany({ where: { isGlobal: true }, select: { id: true, name: true } }),
    prisma.productVariant.findMany({
      where: { product: { isGlobal: true } },
      select: { id: true, name: true, productId: true },
    }),
    prisma.category.findMany({ select: { id: true, name: true, emoji: true } }),
  ]);
  const byName = new Map<string, { id: string; name: string }[]>();
  for (const product of products) {
    const key = normalizeCatalogName(product.name);
    byName.set(key, [...(byName.get(key) ?? []), product]);
  }
  const byProduct = new Map<string, { id: string; name: string }[]>();
  for (const variant of variants) {
    byProduct.set(variant.productId, [
      ...(byProduct.get(variant.productId) ?? []),
      { id: variant.id, name: variant.name },
    ]);
  }
  return {
    products: byName,
    variants: byProduct,
    categories: new Map(categories.map((c) => [normalizeCatalogName(c.name), c])),
  };
}

// A variant is looked up under its product only: the same variant name under another product is
// not a match.
function planVariant(cell: ManifestCell, index: CatalogIndex): ProductPlan {
  const parentName = cell.parent ?? '';
  const parents = index.products.get(normalizeCatalogName(parentName)) ?? [];
  if (parents.length === 0) return { kind: 'not-found', reason: `нет товара «${parentName}»` };
  if (parents.length > 1) {
    return { kind: 'ambiguous', productNames: parents.map((product) => product.name) };
  }
  const [parent] = parents;
  const matches = (index.variants.get(parent.id) ?? []).filter(
    (variant) => normalizeCatalogName(variant.name) === normalizeCatalogName(cell.name)
  );
  if (matches.length === 0) {
    return {
      kind: 'not-found',
      reason: `нет варианта «${cell.name}» у товара «${parent.name}»`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous-variant',
      productName: parent.name,
      variantNames: matches.map((variant) => variant.name),
    };
  }
  return {
    kind: 'variant',
    variantId: matches[0].id,
    productName: parent.name,
    variantName: matches[0].name,
  };
}

export function planProduct(cell: ManifestCell, index: CatalogIndex): ProductPlan {
  if (cell.supersededBy) return { kind: 'superseded', by: cell.supersededBy };
  if (cell.target === 'variant') return planVariant(cell, index);
  if (cell.target === 'category') {
    const category = index.categories.get(normalizeCatalogName(cell.name));
    return category
      ? { kind: 'category', categoryId: category.id, categoryName: category.name }
      : { kind: 'not-found', reason: `нет категории «${cell.name}»` };
  }

  const matches = index.products.get(normalizeCatalogName(cell.name)) ?? [];
  if (matches.length > 1) {
    return { kind: 'ambiguous', productNames: matches.map((product) => product.name) };
  }
  const [product] = matches;
  if (product) return { kind: 'link', productId: product.id, productName: product.name };
  // A queue product must already exist: an update never creates a product.
  if (cell.target === 'product') return { kind: 'not-found', reason: `нет товара «${cell.name}»` };

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
  // False when every record already held what this run would write.
  changed: boolean;
  product:
    | 'linked'
    | 'created'
    | 'variant'
    | 'category'
    | 'library-only'
    | 'superseded'
    | 'ambiguous'
    | 'ambiguous-variant'
    | 'not-found';
  productName?: string;
};

type LibraryData = {
  imageUrl: string;
  name: string;
  nameEn: string;
  tags: string[];
  source: string;
  locale: 'ru' | 'en' | null;
  groupKey: string;
};

function sameLibraryItem(row: EmojiLibraryItem | null, data: LibraryData) {
  return (
    row !== null &&
    row.imageUrl === data.imageUrl &&
    row.name === data.name &&
    row.nameEn === data.nameEn &&
    row.source === data.source &&
    row.locale === data.locale &&
    row.groupKey === data.groupKey &&
    row.tags.length === data.tags.length &&
    row.tags.every((tag, i) => tag === data.tags[i])
  );
}

// True when the stored record already holds every picture field this run would write.
function holds(current: Record<string, unknown> | null, picture: Record<string, unknown>) {
  return (
    current !== null && Object.entries(picture).every(([key, value]) => current[key] === value)
  );
}

// Writes one cell. Pictures already stored under the cell reference are reused, so a re-run
// uploads nothing, and a record that already holds the picture is left untouched.
export async function applyCell(
  prisma: PrismaClient,
  plan: CellPlan,
  upload: Uploader,
  discard?: Discarder
): Promise<AppliedCell> {
  const { cell, ref, images } = plan;
  const textBatch = plan.batchKind === 'text';
  // A category has no English picture, so a label on its picture cannot be shown anywhere.
  if (textBatch && plan.product.kind === 'category') {
    throw new Error(`${ref}: a category picture must be text-free`);
  }
  let uploaded = 0;
  let changed = false;

  const store = async (
    locale: 'ru' | 'en' | null,
    image: Buffer,
    sourceRef: string,
    existing?: string
  ) => {
    const imageUrl = existing ?? (await upload(image, locale === 'en' ? cell.nameEn : cell.name));
    const fresh = !existing;
    if (fresh) uploaded++;
    const data: LibraryData = {
      imageUrl,
      name: cell.name,
      nameEn: cell.nameEn,
      tags: [normalizeCatalogName(cell.category)],
      source: 'batch',
      locale,
      groupKey: ref,
    };
    const current = await prisma.emojiLibraryItem.findUnique({ where: { sourceRef } });
    if (sameLibraryItem(current, data)) return imageUrl;
    try {
      await prisma.emojiLibraryItem.upsert({
        where: { sourceRef },
        create: { sourceRef, ...data },
        update: data,
      });
      changed = true;
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
    imageUrl,
    ...(imageUrlEn || !textBatch ? { imageUrlEn } : {}),
  };
  const kind = plan.product.kind;

  if (kind === 'link') {
    const { productId, productName } = plan.product;
    const data = { isCustom: true, ...picture };
    const current = await prisma.product.findUnique({
      where: { id: productId },
      select: { imageUrl: true, imageUrlEn: true, isCustom: true },
    });
    if (!holds(current, data)) {
      await prisma.product.update({ where: { id: productId }, data });
      changed = true;
    }
    return { ref, name: cell.name, uploaded, changed, product: 'linked', productName };
  }
  if (kind === 'create') {
    await prisma.product.create({
      data: {
        name: cell.name,
        nameEn: cell.nameEn,
        emoji: plan.product.categoryEmoji,
        categoryId: plan.product.categoryId,
        isGlobal: true,
        isCustom: true,
        ...picture,
      },
    });
    return { ref, name: cell.name, uploaded, changed: true, product: 'created' };
  }
  if (kind === 'variant') {
    const { variantId, productName, variantName } = plan.product;
    const current = await prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { imageUrl: true, imageUrlEn: true },
    });
    if (!holds(current, picture)) {
      await prisma.productVariant.update({ where: { id: variantId }, data: picture });
      changed = true;
    }
    return {
      ref,
      name: cell.name,
      uploaded,
      changed,
      product: 'variant',
      productName: `${productName} / ${variantName}`,
    };
  }
  if (kind === 'category') {
    const { categoryId, categoryName } = plan.product;
    // Shown only when flagged custom, the same as a product picture.
    const data = { isCustom: true, imageUrl };
    const current = await prisma.category.findUnique({
      where: { id: categoryId },
      select: { imageUrl: true, isCustom: true },
    });
    if (!holds(current, data)) {
      await prisma.category.update({ where: { id: categoryId }, data });
      changed = true;
    }
    return {
      ref,
      name: cell.name,
      uploaded,
      changed,
      product: 'category',
      productName: categoryName,
    };
  }
  if (kind === 'ambiguous') {
    return { ref, name: cell.name, uploaded, changed, product: 'ambiguous' };
  }
  if (kind === 'ambiguous-variant') {
    return { ref, name: cell.name, uploaded, changed, product: 'ambiguous-variant' };
  }
  if (kind === 'not-found') {
    return { ref, name: cell.name, uploaded, changed, product: 'not-found' };
  }
  if (kind === 'superseded') {
    return { ref, name: cell.name, uploaded, changed, product: 'superseded' };
  }
  return { ref, name: cell.name, uploaded, changed, product: 'library-only' };
}
