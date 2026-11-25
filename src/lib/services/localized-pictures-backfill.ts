import { Prisma, type PrismaClient } from '@prisma/client';
import { sanitizeDatabaseErrorMessage } from './emoji-legacy-ru-locales';

// Fills the localized picture fields (AGE-1667) from the legacy columns, while the legacy
// columns stay untouched and the previous release keeps working:
//   - the English legacy URL is copied to localizedImages.en; other keys are kept; when the legacy
//     English URL is cleared, only en is removed and every other locale is kept;
//   - the language of the text on the main picture comes from the library row with the exact
//     same URL: a library row with locale null becomes "none", a library row with a locale keeps it;
//     a main picture that the library does not know, or no main picture, has no language: a stale
//     value is cleared to null (unmarked).
// An empty dictionary is stored as SQL NULL, the same as a row that was never filled.
// The plan is computed in memory from one read, then applied in one Serializable transaction and
// verified by a re-read; a second run on unchanged data plans zero writes.

export const TEXT_LOCALE_NONE = 'none';
export const ENGLISH_LOCALE_KEY = 'en';

export const BACKFILL_MODELS = ['product', 'productVariant', 'listHistoryItem'] as const;
export type BackfillModel = (typeof BACKFILL_MODELS)[number];

export type JsonObject = Record<string, unknown>;

// One row as the backfill sees it. `localized` is the raw JSON column value.
export type PictureRow = {
  id: string;
  main: string | null;
  en: string | null;
  textLocale: string | null;
  localized: unknown;
};

// Exact library URL -> library locale (null = text-free picture).
export type LibraryLocales = ReadonlyMap<string, string | null>;

// undefined = leave the column alone; null = store SQL NULL.
export type RowWrite = {
  id: string;
  imageTextLocale?: string | null;
  localizedImages?: JsonObject | null;
};

export type PictureCounts = {
  rows: number;
  withMainPicture: number;
  withEnglishUrl: number;
  englishCopyMissing: number;
  unmarked: number;
  textNone: number;
  textLocale: number;
};

export type ModelPlan = {
  model: BackfillModel;
  rows: PictureRow[];
  writes: RowWrite[];
  before: PictureCounts;
  projectedAfter: PictureCounts;
  writeCounts: { rows: number; textLocale: number; english: number };
};

export type BackfillPlan = {
  models: ModelPlan[];
  libraryRows: number;
};

export type BackfillDb = Pick<
  PrismaClient,
  'product' | 'productVariant' | 'listHistoryItem' | 'emojiLibraryItem'
>;

// Column names per model. A history row keeps its product picture under the productImage* prefix.
type ModelAccess = {
  load: (db: BackfillDb) => Promise<PictureRow[]>;
  write: (db: BackfillDb, write: RowWrite) => Promise<unknown>;
};

function localizedToJsonField(
  localized: JsonObject | null
): Prisma.InputJsonObject | typeof Prisma.DbNull {
  return localized === null ? Prisma.DbNull : (localized as Prisma.InputJsonObject);
}

const MODEL_ACCESS: Record<BackfillModel, ModelAccess> = {
  product: {
    load: async (db) =>
      (
        await db.product.findMany({
          select: {
            id: true,
            imageUrl: true,
            imageUrlEn: true,
            imageTextLocale: true,
            localizedImages: true,
          },
          orderBy: { id: 'asc' },
        })
      ).map((row) => ({
        id: row.id,
        main: row.imageUrl,
        en: row.imageUrlEn,
        textLocale: row.imageTextLocale,
        localized: row.localizedImages,
      })),
    write: (db, write) =>
      db.product.update({
        where: { id: write.id },
        data: {
          ...(write.imageTextLocale !== undefined && { imageTextLocale: write.imageTextLocale }),
          ...(write.localizedImages !== undefined && {
            localizedImages: localizedToJsonField(write.localizedImages),
          }),
        },
      }),
  },
  productVariant: {
    load: async (db) =>
      (
        await db.productVariant.findMany({
          select: {
            id: true,
            imageUrl: true,
            imageUrlEn: true,
            imageTextLocale: true,
            localizedImages: true,
          },
          orderBy: { id: 'asc' },
        })
      ).map((row) => ({
        id: row.id,
        main: row.imageUrl,
        en: row.imageUrlEn,
        textLocale: row.imageTextLocale,
        localized: row.localizedImages,
      })),
    write: (db, write) =>
      db.productVariant.update({
        where: { id: write.id },
        data: {
          ...(write.imageTextLocale !== undefined && { imageTextLocale: write.imageTextLocale }),
          ...(write.localizedImages !== undefined && {
            localizedImages: localizedToJsonField(write.localizedImages),
          }),
        },
      }),
  },
  listHistoryItem: {
    load: async (db) =>
      (
        await db.listHistoryItem.findMany({
          select: {
            id: true,
            productImageUrl: true,
            productImageUrlEn: true,
            imageTextLocale: true,
            localizedImages: true,
          },
          orderBy: { id: 'asc' },
        })
      ).map((row) => ({
        id: row.id,
        main: row.productImageUrl,
        en: row.productImageUrlEn,
        textLocale: row.imageTextLocale,
        localized: row.localizedImages,
      })),
    write: (db, write) =>
      db.listHistoryItem.update({
        where: { id: write.id },
        data: {
          ...(write.imageTextLocale !== undefined && {
            imageTextLocale: write.imageTextLocale,
          }),
          ...(write.localizedImages !== undefined && {
            localizedImages: localizedToJsonField(write.localizedImages),
          }),
        },
      }),
  },
};

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// null/absent is an empty dictionary. Anything else that is not an object cannot be extended
// without losing data, so the whole run fails closed instead of guessing.
export function dictionaryOf(row: Pick<PictureRow, 'id' | 'localized'>): JsonObject {
  if (row.localized === null || row.localized === undefined) return {};
  if (!isPlainObject(row.localized)) {
    throw new Error(`localizedImages of row ${row.id} is not a JSON object; refusing to guess`);
  }
  return row.localized;
}

function emptyCounts(): PictureCounts {
  return {
    rows: 0,
    withMainPicture: 0,
    withEnglishUrl: 0,
    englishCopyMissing: 0,
    unmarked: 0,
    textNone: 0,
    textLocale: 0,
  };
}

// Counts the state of the rows; used for "before", for the projection and for the re-read check.
export function countRows(rows: readonly PictureRow[]): PictureCounts {
  const counts = emptyCounts();
  for (const row of rows) {
    counts.rows += 1;
    if (row.main !== null) counts.withMainPicture += 1;
    if (row.en !== null) {
      counts.withEnglishUrl += 1;
      if (dictionaryOf(row)[ENGLISH_LOCALE_KEY] !== row.en) counts.englishCopyMissing += 1;
    }
    if (row.main !== null && row.textLocale === null) counts.unmarked += 1;
    if (row.textLocale === TEXT_LOCALE_NONE) counts.textNone += 1;
    else if (row.textLocale !== null) counts.textLocale += 1;
  }
  return counts;
}

// The write, if any, that brings one row in line with the legacy columns and the library.
export function planRow(row: PictureRow, libraryLocales: LibraryLocales): RowWrite | null {
  const write: RowWrite = { id: row.id };
  let changed = false;

  // A main picture that is absent or unknown to the library has no language: clear a stale value.
  const derivedLocale =
    row.main !== null && libraryLocales.has(row.main)
      ? (libraryLocales.get(row.main) ?? TEXT_LOCALE_NONE)
      : null;
  if (row.textLocale !== derivedLocale) {
    write.imageTextLocale = derivedLocale;
    changed = true;
  }

  const dictionary = dictionaryOf(row);
  if (row.en !== null) {
    if (dictionary[ENGLISH_LOCALE_KEY] !== row.en) {
      write.localizedImages = { ...dictionary, [ENGLISH_LOCALE_KEY]: row.en };
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(dictionary, ENGLISH_LOCALE_KEY)) {
    // The legacy English URL was cleared: drop the stale en and keep every other locale.
    const rest: JsonObject = { ...dictionary };
    delete rest[ENGLISH_LOCALE_KEY];
    write.localizedImages = Object.keys(rest).length > 0 ? rest : null;
    changed = true;
  }

  return changed ? write : null;
}

// The rows as they would look after the writes; used for the dry-run projection.
export function applyWrites(
  rows: readonly PictureRow[],
  writes: readonly RowWrite[]
): PictureRow[] {
  const byId = new Map(writes.map((write) => [write.id, write]));
  return rows.map((row) => {
    const write = byId.get(row.id);
    if (!write) return row;
    return {
      ...row,
      textLocale: write.imageTextLocale !== undefined ? write.imageTextLocale : row.textLocale,
      localized: write.localizedImages !== undefined ? write.localizedImages : row.localized,
    };
  });
}

export function planModel(
  model: BackfillModel,
  rows: PictureRow[],
  libraryLocales: LibraryLocales
): ModelPlan {
  const writes: RowWrite[] = [];
  for (const row of rows) {
    const write = planRow(row, libraryLocales);
    if (write) writes.push(write);
  }
  return {
    model,
    rows,
    writes,
    before: countRows(rows),
    projectedAfter: countRows(applyWrites(rows, writes)),
    writeCounts: {
      rows: writes.length,
      textLocale: writes.filter((write) => write.imageTextLocale !== undefined).length,
      english: writes.filter((write) => write.localizedImages !== undefined).length,
    },
  };
}

export async function loadLibraryLocales(db: BackfillDb): Promise<{
  locales: LibraryLocales;
  rows: number;
}> {
  const rows = await db.emojiLibraryItem.findMany({
    select: { imageUrl: true, locale: true },
    orderBy: { id: 'asc' },
  });
  return {
    locales: new Map(rows.map((row) => [row.imageUrl, row.locale])),
    rows: rows.length,
  };
}

export async function planBackfill(db: BackfillDb): Promise<BackfillPlan> {
  const library = await loadLibraryLocales(db);
  const models: ModelPlan[] = [];
  for (const model of BACKFILL_MODELS) {
    const rows = await MODEL_ACCESS[model].load(db);
    models.push(planModel(model, rows, library.locales));
  }
  return { models, libraryRows: library.rows };
}

export type BackfillTotals = {
  before: PictureCounts;
  after: PictureCounts;
  writeCounts: ModelPlan['writeCounts'];
};

export function totalsOf(models: readonly ModelPlan[]): BackfillTotals {
  const keys = Object.keys(emptyCounts()) as Array<keyof PictureCounts>;
  const sumCounts = (list: PictureCounts[]): PictureCounts =>
    Object.fromEntries(
      keys.map((key) => [key, list.reduce((total, counts) => total + counts[key], 0)])
    ) as PictureCounts;
  return {
    before: sumCounts(models.map((plan) => plan.before)),
    after: sumCounts(models.map((plan) => plan.projectedAfter)),
    writeCounts: {
      rows: models.reduce((n, plan) => n + plan.writeCounts.rows, 0),
      textLocale: models.reduce((n, plan) => n + plan.writeCounts.textLocale, 0),
      english: models.reduce((n, plan) => n + plan.writeCounts.english, 0),
    },
  };
}

export type ApplyOptions = {
  // Test seam: called after each row write, inside the transaction. Throwing rolls everything back.
  onRowWritten?: (model: BackfillModel, id: string) => void | Promise<void>;
};

export type ApplyResult = {
  plan: BackfillPlan;
  appliedWrites: number;
  actualAfter: PictureCounts[];
};

// Writes the plan in one Serializable transaction. After the writes the data is re-read: the
// counts must equal the projection, and a fresh plan must find nothing left to write.
export async function applyBackfill(
  prisma: Pick<PrismaClient, '$transaction'>,
  options: ApplyOptions = {}
): Promise<ApplyResult> {
  return prisma.$transaction(
    async (tx) => {
      const plan = await planBackfill(tx);
      let appliedWrites = 0;
      for (const model of plan.models) {
        for (const write of model.writes) {
          await MODEL_ACCESS[model.model].write(tx, write);
          appliedWrites += 1;
          await options.onRowWritten?.(model.model, write.id);
        }
      }

      const library = (await loadLibraryLocales(tx)).locales;
      const actualAfter: PictureCounts[] = [];
      for (const model of plan.models) {
        const rows = await MODEL_ACCESS[model.model].load(tx);
        const counts = countRows(rows);
        const residual = planModel(model.model, rows, library);
        if (JSON.stringify(counts) !== JSON.stringify(model.projectedAfter)) {
          throw new Error(`${model.model}: state after apply differs from the projection`);
        }
        if (residual.writes.length !== 0) {
          throw new Error(`${model.model}: ${residual.writes.length} row(s) still need a write`);
        }
        actualAfter.push(counts);
      }
      return { plan, appliedWrites, actualAfter };
    },
    { isolationLevel: 'Serializable', timeout: 120_000 }
  );
}

export function formatCounts(counts: PictureCounts): string {
  return [
    `rows ${counts.rows}`,
    `main picture ${counts.withMainPicture}`,
    `English URL ${counts.withEnglishUrl}`,
    `English copy missing ${counts.englishCopyMissing}`,
    `unmarked ${counts.unmarked}`,
    `text none ${counts.textNone}`,
    `text with locale ${counts.textLocale}`,
  ].join(', ');
}

export function sanitizeBackfillError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeDatabaseErrorMessage(message);
}
