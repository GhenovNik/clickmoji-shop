import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, type EmojiLibraryItem, type PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { localizedImagesForStorage } from '@/lib/picture-storage';
import { localizedImagesOf } from '@/lib/product-image';
import { normalizeEmojiImage } from '@/lib/services/emoji-image-normalize';

// Batch import (AGE-1465 item 2): the operator's Gemini sheets (3 columns, cells left to right,
// top to bottom) plus docs/emoji-batches/manifest.json and queue-manifest.json → normalized emoji
// in the library and on catalogue records. Every cell has a stable reference ("batch-007#3"), so
// a second run reuses what is stored instead of uploading again, and writes nothing that is
// already in place.
//
// A queue cell (AGE-1667) has a `target`. Its catalogue record is found by category and parent,
// its library record is bound to the target it was written for at write (created once; a race is
// decided by the winner), and its catalogue write only happens while the record still has no picture,
// or, for an English picture added later to this cell's own Russian one, while its English slot is
// empty. Historical cells (no `target`) keep the old rules.
//
// A replace cell (AGE-1667 C6, action "replace", categories only) swaps a category picture that is
// already there. The operator authorises the exact state it expects to find (--replace-auth, kept out
// of the repository): the old URL and the old isCustom flag. The catalogue write is one conditional
// update on both: it applies when the category still holds them, is "already applied" only when the
// category holds this cell's own URL, flagged custom, with its library record owning that URL, and
// conflicts otherwise. A manual change to either field, or to the mode, is never overwritten.

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
  action: 'create' | 'update-image' | 'replace';
  // The product's picture now comes from this text-batch cell; this one stays in the library.
  supersededBy?: string;
  target?: ManifestTarget;
  // Variant only: the name of its catalogue product. The variant is looked up under that product.
  parent?: string;
};

// The state a replace cell expects to find on its category, given by the operator at apply time:
// the old picture URL and the old isCustom flag.
export type ReplacementAuthorization = { expectedImageUrl: string; expectedIsCustom: boolean };

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
  // Two catalogue categories have the same normalized name: the cell's category is unknown.
  | { kind: 'ambiguous-category'; categoryNames: string[] }
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
  // Set for a replace cell whose category is found: the authorised old URL.
  replacement?: ReplacementAuthorization;
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

// Keys: the normalized category name of each replace cell in the manifest.
export const REPLACE_AUTH_FIELDS = ['category', 'expectedImageUrl', 'expectedIsCustom'] as const;

// Validates the operator's replacement authorisation before anything is read or uploaded. The file
// is { "replacements": [{ "category": "<catalogue category name>", "expectedImageUrl": "https://…",
// "expectedIsCustom": true | false }] } and must name exactly the replace cells of the selected
// batches: a missing one is refused, an unknown or duplicate one is refused, a URL that is not an
// absolute https URL is refused, and expectedIsCustom must be a boolean.
// Returns the authorised state per normalized category name.
export function parseReplacementAuthorization(
  json: unknown,
  manifest: ManifestBatch[],
  selected: ManifestBatch[]
): Map<string, ReplacementAuthorization> {
  const fail = (reason: string): never => {
    throw new Error(`--replace-auth: ${reason}`);
  };
  const replaceNames = (batches: ManifestBatch[]) =>
    batches.flatMap((batch) =>
      batch.cells.filter((cell) => cell.action === 'replace').map((cell) => cell.name)
    );
  const known = new Set(replaceNames(manifest).map(normalizeCatalogName));
  const required = new Set(replaceNames(selected).map(normalizeCatalogName));

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    fail('ожидается объект { "replacements": [...] }');
  }
  const top = json as Record<string, unknown>;
  if (Object.keys(top).some((key) => key !== 'replacements')) {
    fail(
      `неизвестное поле в корне: ${Object.keys(top)
        .filter((k) => k !== 'replacements')
        .join(', ')}`
    );
  }
  if (!Array.isArray(top.replacements)) fail('поле "replacements" должно быть массивом');

  const result = new Map<string, ReplacementAuthorization>();
  for (const entry of top.replacements as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('каждая запись — объект с полями "category", "expectedImageUrl" и "expectedIsCustom"');
    }
    const fields = entry as Record<string, unknown>;
    const keys = Object.keys(fields);
    if (
      keys.length !== REPLACE_AUTH_FIELDS.length ||
      !REPLACE_AUTH_FIELDS.every((k) => keys.includes(k))
    ) {
      fail(
        `запись должна иметь ровно поля "category", "expectedImageUrl" и "expectedIsCustom" (есть: ${keys.join(', ')})`
      );
    }
    const { category, expectedImageUrl, expectedIsCustom } = fields;
    if (typeof category !== 'string' || category.trim() === '') fail('пустое название категории');
    if (typeof expectedImageUrl !== 'string') fail(`«${category}»: URL должен быть строкой`);
    if (typeof expectedIsCustom !== 'boolean') {
      fail(`«${category}»: expectedIsCustom должен быть true или false`);
    }
    const key = normalizeCatalogName(category as string);
    if (!known.has(key)) fail(`«${category}» не заменяемая категория (replace в манифесте нет)`);
    if (result.has(key)) fail(`«${category}» указана дважды`);
    let url: URL;
    try {
      url = new URL(expectedImageUrl as string);
    } catch {
      fail(`«${category}»: URL не разобран`);
      throw new Error('unreachable');
    }
    if (url.protocol !== 'https:' || /\s/.test(expectedImageUrl as string)) {
      fail(`«${category}»: нужен абсолютный https-адрес без пробелов`);
    }
    result.set(key, {
      expectedImageUrl: expectedImageUrl as string,
      expectedIsCustom: expectedIsCustom as boolean,
    });
  }
  const missing = [...required].filter((key) => !result.has(key));
  if (missing.length > 0) fail(`нет записей для замены: ${missing.join(', ')}`);
  return result;
}

export type CatalogProduct = { id: string; name: string; categoryId: string; categoryName: string };
export type CatalogCategory = { id: string; name: string; emoji: string };

export type CatalogIndex = {
  // Global products by normalized name.
  products: Map<string, CatalogProduct[]>;
  // Variants of global products, by product id.
  variants: Map<string, { id: string; name: string }[]>;
  // Historical lookup by normalized name; on a collision the last category wins, as before.
  categories: Map<string, CatalogCategory>;
  // Every category by normalized name: more than one entry is a collision that cannot be resolved.
  categoriesByKey: Map<string, CatalogCategory[]>;
};

export async function loadCatalogIndex(prisma: PrismaClient): Promise<CatalogIndex> {
  const [products, variants, categories] = await Promise.all([
    prisma.product.findMany({
      where: { isGlobal: true },
      select: { id: true, name: true, categoryId: true, category: { select: { name: true } } },
    }),
    prisma.productVariant.findMany({
      where: { product: { isGlobal: true } },
      select: { id: true, name: true, productId: true },
    }),
    prisma.category.findMany({ select: { id: true, name: true, emoji: true } }),
  ]);
  const byName = new Map<string, CatalogProduct[]>();
  for (const product of products) {
    const key = normalizeCatalogName(product.name);
    const entry = {
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      categoryName: product.category.name,
    };
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  const byProduct = new Map<string, { id: string; name: string }[]>();
  for (const variant of variants) {
    byProduct.set(variant.productId, [
      ...(byProduct.get(variant.productId) ?? []),
      { id: variant.id, name: variant.name },
    ]);
  }
  const byCategory = new Map<string, CatalogCategory[]>();
  for (const category of categories) {
    const key = normalizeCatalogName(category.name);
    byCategory.set(key, [...(byCategory.get(key) ?? []), category]);
  }
  return {
    products: byName,
    variants: byProduct,
    categories: new Map(categories.map((c) => [normalizeCatalogName(c.name), c])),
    categoriesByKey: byCategory,
  };
}

// Queue targets are identified by their category: a product of the same name in another category
// is another product, and a variant belongs to its parent's category. Two categories whose names
// collide after normalization cannot be told apart, so nothing in them is matched.
function productsInCategory(
  cell: ManifestCell,
  name: string,
  index: CatalogIndex,
  label: string
): { products: CatalogProduct[] } | { plan: ProductPlan } {
  const categories = index.categoriesByKey.get(normalizeCatalogName(cell.category)) ?? [];
  if (categories.length > 1) {
    return { plan: { kind: 'ambiguous-category', categoryNames: categories.map((c) => c.name) } };
  }
  const [category] = categories;
  if (!category) {
    return { plan: { kind: 'not-found', reason: `нет категории «${cell.category}»` } };
  }
  const named = index.products.get(normalizeCatalogName(name)) ?? [];
  const products = named.filter((product) => product.categoryId === category.id);
  if (products.length > 0) return { products };

  const elsewhere = [...new Set(named.map((product) => product.categoryName))];
  return {
    plan: {
      kind: 'not-found',
      reason:
        elsewhere.length === 0
          ? `нет ${label} «${name}»`
          : `нет ${label} «${name}» в категории «${category.name}» (есть в «${elsewhere.join('», «')}»)`,
    },
  };
}

// A variant is looked up under its product only: the same variant name under another product is
// not a match.
function planVariant(cell: ManifestCell, index: CatalogIndex): ProductPlan {
  const scope = productsInCategory(cell, cell.parent ?? '', index, 'товара');
  if ('plan' in scope) return scope.plan;
  const { products: parents } = scope;
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
    const categories = index.categoriesByKey.get(normalizeCatalogName(cell.name)) ?? [];
    if (categories.length > 1) {
      return { kind: 'ambiguous-category', categoryNames: categories.map((c) => c.name) };
    }
    const [category] = categories;
    return category
      ? { kind: 'category', categoryId: category.id, categoryName: category.name }
      : { kind: 'not-found', reason: `нет категории «${cell.name}»` };
  }
  if (cell.target === 'product') {
    const scope = productsInCategory(cell, cell.name, index, 'товара');
    if ('plan' in scope) return scope.plan;
    if (scope.products.length > 1) {
      return { kind: 'ambiguous', productNames: scope.products.map((product) => product.name) };
    }
    const [product] = scope.products;
    return { kind: 'link', productId: product.id, productName: product.name };
  }

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

// The target a library record was written for: its category and, for a queue cell, its kind and
// parent. A reordered queue puts another target under the same reference; its record then carries
// different tags and is refused instead of being reused.
export function libraryTags(cell: ManifestCell): string[] {
  const category = normalizeCatalogName(cell.category);
  if (cell.target === undefined) return [category];
  return [
    category,
    `queue:${cell.target}`,
    ...(cell.target === 'variant' ? [`parent:${normalizeCatalogName(cell.parent ?? '')}`] : []),
  ];
}

export function ownsLibraryItem(item: { name: string; tags: string[] }, cell: ManifestCell) {
  const tags = libraryTags(cell);
  return (
    item.name === cell.name &&
    item.tags.length === tags.length &&
    item.tags.every((tag, i) => tag === tags[i])
  );
}

export type StoredPicture = { imageUrl: string; name: string; tags: string[] };

export async function storedPictures(prisma: PrismaClient, refs: string[]) {
  const items = await prisma.emojiLibraryItem.findMany({
    where: { sourceRef: { in: refs.flatMap((ref) => [ref, `${ref}:en`]) } },
    select: { sourceRef: true, imageUrl: true, name: true, tags: true },
  });
  return new Map<string, StoredPicture>(
    items.map((item) => [
      item.sourceRef ?? '',
      { imageUrl: item.imageUrl, name: item.name, tags: item.tags },
    ])
  );
}

// Uploads one image and returns its URL. The import never deletes an uploaded file: a URL can be
// published in ListHistoryItem or raced by another run, and an uploader URL alone proves nothing
// about exclusive ownership (AGE-1667 B3). A write that fails may therefore leave an unreferenced file.
export type Uploader = (image: Buffer, name: string) => Promise<string>;

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
    | 'not-found'
    | 'conflict';
  productName?: string;
  // Set when a queue cell was left unwritten because the records changed since they were read.
  conflict?: string;
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

// True when the stored record already holds every flat field this run would write.
function holds(current: Record<string, unknown> | null, picture: Record<string, unknown>) {
  return (
    current !== null && Object.entries(picture).every(([key, value]) => current[key] === value)
  );
}

// A product or variant as an import sees its pictures: the main picture and the raw dictionary
// (`localizedImages`, as stored). The English picture is the dictionary's `en` entry.
type PictureRecord = { imageUrl: string | null; localizedImages?: unknown };

const englishOf = (record: PictureRecord | null) =>
  localizedImagesOf(record?.localizedImages).en ?? null;

// What an import means to write: the main picture and the English entry of the dictionary
// (undefined = leave it as stored, null = remove it, a URL = set it). Other languages are never
// touched.
type PictureIntent = { imageUrl: string | null; english: string | null | undefined };

// True when the record already holds the intent and every flat field written with it.
function holdsIntent(
  current: (PictureRecord & Record<string, unknown>) | null,
  intent: PictureIntent,
  flat: Record<string, unknown> = {}
) {
  return (
    current !== null &&
    current.imageUrl === intent.imageUrl &&
    (intent.english === undefined || englishOf(current) === intent.english) &&
    holds(current, flat)
  );
}

// The picture fields of a write. The dictionary is rewritten only when its English entry changes,
// from the dictionary as read, so the entries of other languages stay. The legacy English column
// (`imageUrlEn`) is written as a rollback mirror only; nothing here reads it.
function pictureData(current: PictureRecord | null, intent: PictureIntent) {
  const data: Record<string, unknown> = { imageUrl: intent.imageUrl };
  if (intent.english === undefined) return data;
  data.imageUrlEn = intent.english;
  if (englishOf(current) !== intent.english) {
    const dictionary = { ...localizedImagesOf(current?.localizedImages) };
    if (intent.english === null) delete dictionary.en;
    else dictionary.en = intent.english;
    data.localizedImages = localizedImagesForStorage(dictionary);
  }
  return data;
}

// The dictionary exactly as read: a write conditioned on it fails when anything in it changed
// between the read and the write (an English picture attached by hand, a language added).
const dictionaryAs = (current: PictureRecord | null) => ({
  localizedImages: {
    equals:
      current?.localizedImages == null
        ? Prisma.DbNull
        : (current.localizedImages as Prisma.InputJsonValue),
  },
});

// A catalogue record as a conditional write sees it. `write` applies the condition on its picture
// slots together with the data; `update` writes by id alone.
type CatalogRecord = {
  current: (PictureRecord & Record<string, unknown>) | null;
  read: () => Promise<(PictureRecord & Record<string, unknown>) | null>;
  write: (
    where: Record<string, unknown>,
    data: Record<string, unknown>
  ) => Promise<{ count: number }>;
  update: (data: Record<string, unknown>) => Promise<unknown>;
  // Products and variants have an English picture slot; categories have none.
  english: boolean;
};

const WRITE_RACE = 'запись изменилась после чтения или её нет';

// Applies one conditional write. Another run may have written this very picture since the read:
// that is the state this run wants.
async function writeWhere(
  record: CatalogRecord,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
  intent: PictureIntent,
  flat: Record<string, unknown>
): Promise<{ changed: boolean; conflict?: string }> {
  const { count } = await record.write(where, data);
  if (count === 1) return { changed: true };
  const after = await record.read();
  if (holdsIntent(after, intent, flat)) return { changed: false };
  return { changed: false, conflict: WRITE_RACE };
}

// A queue write changes a record only while its picture slots are empty. The one exception is an
// English picture added to a Russian one this cell stored itself (`stagedRu`, the library record it
// owns): then only the empty English slot is filled. Each condition is repeated in the database
// write, so a picture attached by hand between the read and the write is never replaced.
async function writeQueuePicture(
  record: CatalogRecord,
  intent: PictureIntent,
  flat: Record<string, unknown>,
  stagedRu?: string
): Promise<{ changed: boolean; conflict?: string }> {
  const { current, english } = record;
  if (holdsIntent(current, intent, flat)) return { changed: false };

  const free =
    current === null || (current.imageUrl === null && (!english || englishOf(current) === null));
  let slot: string | null | undefined;
  if (free) {
    slot = null;
  } else if (
    english &&
    stagedRu !== undefined &&
    current.imageUrl === stagedRu &&
    intent.imageUrl === stagedRu &&
    englishOf(current) === null
  ) {
    slot = stagedRu;
  }
  if (slot === undefined) {
    return { changed: false, conflict: 'уже есть картинка, которую эта пачка не записывает' };
  }

  const where = { imageUrl: slot, ...(english && dictionaryAs(current)) };
  return writeWhere(record, where, { ...flat, ...pictureData(current, intent) }, intent, flat);
}

// A historical cell replaces whatever the record shows. A write that changes the dictionary of a
// record that was read is still conditioned on the state it was computed from, so it never erases
// an entry another run or an admin added meanwhile; any other write is a plain update by id.
async function writePicture(
  record: CatalogRecord,
  intent: PictureIntent,
  flat: Record<string, unknown>
): Promise<{ changed: boolean; conflict?: string }> {
  const { current } = record;
  if (holdsIntent(current, intent, flat)) return { changed: false };
  const data = { ...flat, ...pictureData(current, intent) };
  if (current === null || !('localizedImages' in data)) {
    await record.update(data);
    return { changed: true };
  }
  const where = { imageUrl: current?.imageUrl ?? null, ...dictionaryAs(current) };
  return writeWhere(record, where, data, intent, flat);
}

// Prisma's unique-constraint error. A library insert can collide on `sourceRef` or on the URL.
function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

// The category already shows this cell's own replacement: it holds the URL of the library record this
// cell owns, and that category is flagged custom. A null URL or a record of another target is never it.
function appliedHere(
  category: { imageUrl: string | null; isCustom: boolean },
  library: EmojiLibraryItem | null,
  cell: ManifestCell
) {
  return (
    library !== null &&
    ownsLibraryItem(library, cell) &&
    category.isCustom &&
    category.imageUrl !== null &&
    category.imageUrl === library.imageUrl
  );
}

type Stored = { imageUrl: string } | { conflict: string };

// Writes one cell. Pictures already stored under the cell reference are reused, so a re-run
// uploads nothing, and a record that already holds the picture is left untouched.
export async function applyCell(
  prisma: PrismaClient,
  plan: CellPlan,
  upload: Uploader
): Promise<AppliedCell> {
  const { cell, ref, images } = plan;
  const textBatch = plan.batchKind === 'text';
  const queue = cell.target !== undefined;
  // A category has no English picture, so a label on its picture cannot be shown anywhere.
  if (textBatch && plan.product.kind === 'category') {
    throw new Error(`${ref}: a category picture must be text-free`);
  }
  // A replacement is refused before any read or upload when its old URL was not authorised.
  const replacing = cell.action === 'replace' && plan.product.kind === 'category';
  if (cell.action === 'replace' && !queue) {
    throw new Error(`${ref}: only a queue cell can replace a picture`);
  }
  if (replacing && plan.replacement === undefined) {
    throw new Error(
      `${ref}: replacing the picture of «${cell.name}» needs its authorised old URL (--replace-auth)`
    );
  }

  // Every library read comes before the first upload, so a failed read has nothing to clean up.
  const enRef = `${ref}:en`;
  let ruCurrent = await prisma.emojiLibraryItem.findUnique({ where: { sourceRef: ref } });
  const enCurrent =
    textBatch && images.en
      ? await prisma.emojiLibraryItem.findUnique({ where: { sourceRef: enRef } })
      : null;
  // A queue cell never reuses a record written for another target (AGE-1667).
  for (const row of [ruCurrent, enCurrent]) {
    if (queue && row && !ownsLibraryItem(row, cell)) {
      return {
        ref,
        name: cell.name,
        uploaded: 0,
        changed: false,
        product: 'conflict',
        conflict: `картинка ${ref} записана для другой цели («${row.name}»)`,
      };
    }
  }

  // A replacement reads the category before the first upload. Only the authorised state (old URL and
  // old isCustom flag), or the already-applied state of this cell, may be replaced. Anything else is
  // a manual or concurrent edit and is left alone.
  if (replacing && plan.product.kind === 'category') {
    const current = await prisma.category.findUnique({
      where: { id: plan.product.categoryId },
      select: { imageUrl: true, isCustom: true },
    });
    const authorised = plan.replacement!;
    let accepted =
      current !== null &&
      ((current.imageUrl === authorised.expectedImageUrl &&
        current.isCustom === authorised.expectedIsCustom) ||
        appliedHere(current, ruCurrent, cell));
    if (current !== null && !accepted) {
      // A run that finished between the two reads above wrote this cell's library record and the
      // category: its record is the one this run reuses, so the replay is recognised, not refused.
      const fresh = await prisma.emojiLibraryItem.findUnique({ where: { sourceRef: ref } });
      if (appliedHere(current, fresh, cell)) {
        ruCurrent = fresh;
        accepted = true;
      }
    }
    if (!accepted) {
      return {
        ref,
        name: cell.name,
        uploaded: 0,
        changed: false,
        product: 'conflict',
        productName: plan.product.categoryName,
        conflict: `категория «${plan.product.categoryName}» не содержит ожидаемую старую картинку и режим (изменены вручную или другой пачкой) — замена не записана`,
      };
    }
  }

  let uploaded = 0;
  let changed = false;

  const conflictOf = (conflict: string): AppliedCell => ({
    ref,
    name: cell.name,
    uploaded,
    changed,
    product: 'conflict',
    conflict,
  });

  // Stores one library record. A queue record is bound to its owner at write: it is created once,
  // and an existing one is updated only while the same owner still holds it. When another run has
  // created the reference first, that winner decides: its owner reuses its picture, any other owner
  // is refused and the winner is left as it is.
  const store = async (
    locale: 'ru' | 'en' | null,
    image: Buffer,
    sourceRef: string,
    current: EmojiLibraryItem | null,
    existing: string | undefined
  ): Promise<Stored> => {
    const meta = {
      name: cell.name,
      nameEn: cell.nameEn,
      tags: libraryTags(cell),
      source: 'batch',
      locale,
      groupKey: ref,
    };
    if (existing !== undefined && sameLibraryItem(current, { ...meta, imageUrl: existing })) {
      return { imageUrl: existing };
    }
    if (queue && current !== null) {
      // The owner was checked before any upload; this write keeps the reference bound to it.
      const { count } = await prisma.emojiLibraryItem.updateMany({
        where: { id: current.id, name: cell.name, tags: { equals: meta.tags } },
        data: { ...meta, imageUrl: current.imageUrl },
      });
      if (count !== 1) return { conflict: `картинка ${sourceRef} изменилась во время записи` };
      changed = true;
      return { imageUrl: current.imageUrl };
    }

    const imageUrl = existing ?? (await upload(image, locale === 'en' ? cell.nameEn : cell.name));
    if (existing === undefined) uploaded++;
    const data: LibraryData = { ...meta, imageUrl };
    // A failed write leaves a fresh upload in place: no record proves this run owns its URL, and
    // ListHistoryItem keeps published URLs readable outside the catalogue (AGE-1667 B3).
    try {
      if (queue) {
        await prisma.emojiLibraryItem.create({ data: { sourceRef, ...data } });
      } else {
        await prisma.emojiLibraryItem.upsert({
          where: { sourceRef },
          create: { sourceRef, ...data },
          update: data,
        });
      }
      changed = true;
      return { imageUrl };
    } catch (error) {
      if (!queue || !isUniqueViolation(error)) throw error;
      const winner: EmojiLibraryItem | null = await prisma.emojiLibraryItem.findUnique({
        where: { sourceRef },
      });
      if (winner === null) return { conflict: `картинка ${sourceRef} изменилась во время записи` };
      if (!ownsLibraryItem(winner, cell)) {
        return { conflict: `картинка ${sourceRef} записана для другой цели («${winner.name}»)` };
      }
      return { imageUrl: winner.imageUrl };
    }
  };

  // A queue cell reuses the URL the record read above holds; a historical cell reuses the one the
  // prefetch found. A refused library record stops the cell before any catalogue write.
  const ruStored = await store(
    textBatch ? 'ru' : null,
    images.ru,
    ref,
    ruCurrent,
    queue ? ruCurrent?.imageUrl : plan.stored.ru
  );
  if ('conflict' in ruStored) return conflictOf(ruStored.conflict);
  const imageUrl = ruStored.imageUrl;
  let englishUrl: string | null = null;
  if (textBatch && images.en) {
    const enStored = await store(
      'en',
      images.en,
      enRef,
      enCurrent,
      queue ? enCurrent?.imageUrl : plan.stored.en
    );
    if ('conflict' in enStored) return conflictOf(enStored.conflict);
    englishUrl = enStored.imageUrl;
  }

  // A text-free picture serves both languages, so it clears a stale English one. A Russian
  // label imported before its English sheet leaves an English picture already stored alone.
  const intent: PictureIntent = {
    imageUrl,
    english: englishUrl ?? (textBatch ? undefined : null),
  };
  const kind = plan.product.kind;

  if (kind === 'link') {
    const { productId, productName } = plan.product;
    const flat = { isCustom: true };
    const readProduct = () =>
      prisma.product.findUnique({
        where: { id: productId },
        select: { imageUrl: true, localizedImages: true, isCustom: true },
      });
    const record = (current: Awaited<ReturnType<typeof readProduct>>): CatalogRecord => ({
      current,
      english: true,
      read: readProduct,
      write: (where, data) =>
        prisma.product.updateMany({
          where: { id: productId, ...where },
          data: data as Prisma.ProductUpdateManyMutationInput,
        }),
      update: (data) =>
        prisma.product.update({
          where: { id: productId },
          data: data as Prisma.ProductUpdateInput,
        }),
    });
    const current = await readProduct();
    const write = queue
      ? await writeQueuePicture(record(current), intent, flat, imageUrl)
      : await writePicture(record(current), intent, flat);
    if (write.changed) changed = true;
    return {
      ref,
      name: cell.name,
      uploaded,
      changed,
      product: write.conflict ? 'conflict' : 'linked',
      productName,
      conflict: write.conflict,
    };
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
        ...(pictureData(null, intent) as { imageUrl: string | null }),
      },
    });
    return { ref, name: cell.name, uploaded, changed: true, product: 'created' };
  }
  if (kind === 'variant') {
    const { variantId, productName, variantName } = plan.product;
    const readVariant = () =>
      prisma.productVariant.findUnique({
        where: { id: variantId },
        select: { imageUrl: true, localizedImages: true },
      });
    const current = await readVariant();
    const name = `${productName} / ${variantName}`;
    const record: CatalogRecord = {
      current,
      english: true,
      read: readVariant,
      write: (where, data) =>
        prisma.productVariant.updateMany({
          where: { id: variantId, ...where },
          data: data as Prisma.ProductVariantUpdateManyMutationInput,
        }),
      update: (data) =>
        prisma.productVariant.update({
          where: { id: variantId },
          data: data as Prisma.ProductVariantUpdateInput,
        }),
    };
    const write = queue
      ? await writeQueuePicture(record, intent, {}, imageUrl)
      : await writePicture(record, intent, {});
    if (write.changed) changed = true;
    return {
      ref,
      name: cell.name,
      uploaded,
      changed,
      product: write.conflict ? 'conflict' : 'variant',
      productName: name,
      conflict: write.conflict,
    };
  }
  if (kind === 'category') {
    const { categoryId, categoryName } = plan.product;
    // Shown only when flagged custom, the same as a product picture.
    const data = { isCustom: true, imageUrl };
    const readCategory = () =>
      prisma.category.findUnique({
        where: { id: categoryId },
        select: { imageUrl: true, isCustom: true },
      });
    if (replacing) {
      // One conditional write on the authorised old URL and old isCustom flag. Missing it means the
      // category changed after the read: this cell's own applied state (a run that raced this one) is
      // the same outcome; anything else is a conflict and nothing is overwritten.
      const authorised = plan.replacement!;
      const { count } = await prisma.category.updateMany({
        where: {
          id: categoryId,
          imageUrl: authorised.expectedImageUrl,
          isCustom: authorised.expectedIsCustom,
        },
        data,
      });
      if (count === 1) {
        changed = true;
        return {
          ref,
          name: cell.name,
          uploaded,
          changed,
          product: 'category',
          productName: categoryName,
        };
      }
      const after = await readCategory();
      const library = await prisma.emojiLibraryItem.findUnique({ where: { sourceRef: ref } });
      if (after !== null && after.imageUrl === imageUrl && appliedHere(after, library, cell)) {
        return {
          ref,
          name: cell.name,
          uploaded,
          changed,
          product: 'category',
          productName: categoryName,
        };
      }
      return {
        ref,
        name: cell.name,
        uploaded,
        changed,
        product: 'conflict',
        productName: categoryName,
        conflict: `картинка категории «${categoryName}» изменилась после проверки — замена не записана`,
      };
    }
    const current = await readCategory();
    if (queue) {
      const write = await writeQueuePicture(
        {
          current,
          english: false,
          read: readCategory,
          write: (where, written) =>
            prisma.category.updateMany({
              where: { id: categoryId, ...where },
              data: written as Prisma.CategoryUpdateManyMutationInput,
            }),
          update: (written) =>
            prisma.category.update({
              where: { id: categoryId },
              data: written as Prisma.CategoryUpdateInput,
            }),
        },
        { imageUrl, english: undefined },
        { isCustom: true }
      );
      if (write.changed) changed = true;
      return {
        ref,
        name: cell.name,
        uploaded,
        changed,
        product: write.conflict ? 'conflict' : 'category',
        productName: categoryName,
        conflict: write.conflict,
      };
    }
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
  if (kind === 'ambiguous' || kind === 'ambiguous-category') {
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
