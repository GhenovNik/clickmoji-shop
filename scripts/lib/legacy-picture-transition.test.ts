// @vitest-environment node
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { historyPictureFields } from '../../src/lib/picture-storage';
import { applyWrites, planRow, type PictureRow } from './localized-pictures-backfill';
import { readVisibleSnapshotPictures, withLegacyEnglish } from './legacy-picture-transition';

describe('withLegacyEnglish', () => {
  it('fills the English entry from the legacy column when the dictionary has none', () => {
    expect(withLegacyEnglish({ localizedImages: null, imageUrlEn: '/legacy.webp' })).toEqual({
      en: '/legacy.webp',
    });
    expect(
      withLegacyEnglish({ localizedImages: { ru: '/ru.webp' }, imageUrlEn: '/l.webp' })
    ).toEqual({ ru: '/ru.webp', en: '/l.webp' });
  });

  it('lets the legacy column replace a different dictionary entry and keeps every other language', () => {
    expect(
      withLegacyEnglish({
        localizedImages: { en: '/dictionary.webp', xx: '/xx.webp' },
        imageUrlEn: '/legacy.webp',
      })
    ).toEqual({ en: '/legacy.webp', xx: '/xx.webp' });
  });

  it.each([null, '', '   '])(
    'removes the English entry when the legacy column is cleared (%j)',
    (legacy) => {
      expect(
        withLegacyEnglish({
          localizedImages: { en: '/dictionary.webp', ru: '/ru.webp' },
          imageUrlEn: legacy,
        })
      ).toEqual({ ru: '/ru.webp' });
    }
  );

  it('leaves the dictionary as it is when the column was not read', () => {
    expect(withLegacyEnglish({ localizedImages: { en: '/dictionary.webp' } })).toEqual({
      en: '/dictionary.webp',
    });
  });

  it('gives the English entry the backfill gives it, in every state the two places can be in', () => {
    const states: Array<[unknown, string | null]> = [
      [null, null],
      [null, '/b.webp'],
      [{ en: '/a.webp' }, '/a.webp'],
      [{ en: '/a.webp' }, '/b.webp'],
      [{ en: '/a.webp' }, null],
      [{ en: '/a.webp', ru: '/ru.webp', xx: '/xx.webp' }, '/b.webp'],
      [{ ru: '/ru.webp' }, null],
    ];
    for (const [localizedImages, imageUrlEn] of states) {
      const row: PictureRow = {
        id: 'p',
        main: null,
        en: imageUrlEn,
        textLocale: null,
        localized: localizedImages as PictureRow['localized'],
      };
      const [after] = applyWrites(
        [row],
        [planRow(row, new Map())].filter((w) => w !== null)
      );
      expect(withLegacyEnglish({ localizedImages, imageUrlEn })).toEqual(after.localized ?? {});
    }
  });

  it('does not change its input', () => {
    const localizedImages = { ru: '/ru.webp' };
    withLegacyEnglish({ localizedImages, imageUrlEn: '/legacy.webp' });
    expect(localizedImages).toEqual({ ru: '/ru.webp' });
  });
});

describe('readVisibleSnapshotPictures', () => {
  const rows = [
    {
      id: 'milk',
      imageUrl: '/milk.webp',
      imageTextLocale: 'ru',
      localizedImages: null,
      imageUrlEn: '/milk-en.webp',
    },
    {
      id: 'bread',
      imageUrl: null,
      imageTextLocale: null,
      localizedImages: { en: '/bread-en.webp' },
      imageUrlEn: '/bread-old.webp',
    },
  ];

  function reader() {
    const findMany = vi.fn(async (_args: unknown) => rows);
    return { findMany, tx: { product: { findMany } } as unknown as Prisma.TransactionClient };
  }

  it('reads picture fields and the legacy column in one statement and returns canonical dictionaries', async () => {
    const { findMany, tx } = reader();
    const where = { id: { in: ['milk', 'bread'] }, isGlobal: true };

    const pictures = await readVisibleSnapshotPictures(tx, where);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where,
      select: { imageUrlEn: true, localizedImages: true, imageUrl: true },
    });
    expect(pictures.get('milk')).toEqual({
      imageUrl: '/milk.webp',
      imageTextLocale: 'ru',
      localizedImages: { en: '/milk-en.webp' },
    });
    expect(pictures.get('bread')?.localizedImages).toEqual({ en: '/bread-old.webp' });
    // The legacy value never leaves the helper as a field of its own.
    expect(JSON.stringify([...pictures.values()])).not.toMatch(/imageUrlEn/);
  });

  it('fails loudly when the read fails', async () => {
    const tx = {
      product: {
        findMany: async () => {
          throw new Error('connection reset');
        },
      },
    } as unknown as Prisma.TransactionClient;
    await expect(readVisibleSnapshotPictures(tx, {})).rejects.toThrow('connection reset');
  });
});

// One scenario, two backfill passes (Poco r3, AC-4): the first pass puts A into both places, the
// previous release then replaces (B) or clears (null) the legacy column, a list is completed by the
// new code between the passes, and the second pass brings the products in line. The snapshot must
// hold what the old catalogue showed when the list was completed, and later catalogue changes and
// the repeat backfill must not touch it.
describe('snapshot between two backfill passes', () => {
  const A = '/a-en.webp';
  const B = '/b-en.webp';
  const LATER = '/later-en.webp';

  type Product = PictureRow & { imageUrlEn: string | null };
  const emptyLibrary = new Map<string, string | null>();

  const products = (): Product[] =>
    ['replaced', 'cleared', 'untouched'].map((id) => ({
      id,
      main: `/${id}-main.webp`,
      en: A,
      textLocale: null,
      localized: null,
      imageUrlEn: A,
    }));

  // A pass of the backfill over the products, applied in place.
  function backfill(rows: Product[]) {
    const writes = rows.flatMap((row) => planRow(row, emptyLibrary) ?? []);
    return applyWrites(rows, writes).map((row, index) => ({ ...rows[index], ...row }));
  }

  const dictionaryOf = (rows: Product[], id: string) =>
    rows.find((row) => row.id === id)!.localized;

  // The snapshot code of POST /api/history: the one read, then the ordinary copy.
  async function complete(rows: Product[]) {
    const tx = {
      product: {
        findMany: async () =>
          rows.map((row) => ({
            id: row.id,
            imageUrl: row.main,
            imageTextLocale: row.textLocale,
            localizedImages: row.localized,
            imageUrlEn: row.en,
          })),
      },
    } as unknown as Prisma.TransactionClient;
    const pictures = await readVisibleSnapshotPictures(tx, {});
    return rows.map((row) => ({ id: row.id, ...historyPictureFields(pictures.get(row.id)!) }));
  }

  it('keeps what the old catalogue showed at completion and ignores later changes', async () => {
    // Pass 1: only the legacy column holds A.
    let rows = backfill(products().map((row) => ({ ...row, localized: null })));
    expect(rows.map((row) => row.localized)).toEqual([{ en: A }, { en: A }, { en: A }]);

    // The previous release writes the legacy column alone.
    rows = rows.map((row) =>
      row.id === 'replaced' ? { ...row, en: B } : row.id === 'cleared' ? { ...row, en: null } : row
    );

    // The new code completes the list before the second pass.
    const snapshots = await complete(rows);
    const english = (id: string) => {
      const snapshot = snapshots.find((row) => row.id === id)!;
      return { dictionary: snapshot.localizedImages, mirror: snapshot.productImageUrlEn };
    };
    expect(english('replaced')).toEqual({ dictionary: { en: B }, mirror: B });
    expect(english('cleared').mirror).toBeNull();
    expect(JSON.stringify(snapshots.find((row) => row.id === 'cleared'))).not.toContain(A);
    expect(english('untouched')).toEqual({ dictionary: { en: A }, mirror: A });
    const stored = JSON.stringify(snapshots);

    // Pass 2: the products now agree with the old catalogue.
    rows = backfill(rows);
    expect(dictionaryOf(rows, 'replaced')).toEqual({ en: B });
    expect(dictionaryOf(rows, 'cleared')).toBeNull();
    expect(dictionaryOf(rows, 'untouched')).toEqual({ en: A });

    // The catalogue moves on and the backfill runs once more: the stored history is a copy.
    rows = backfill(rows.map((row) => ({ ...row, en: LATER, imageUrlEn: LATER })));
    expect(dictionaryOf(rows, 'cleared')).toEqual({ en: LATER });
    expect(JSON.stringify(snapshots)).toBe(stored);
    expect(stored).not.toContain(LATER);

    // The backfill of the history rows has nothing to change in the snapshots either.
    const historyRows: PictureRow[] = snapshots.map((snapshot) => ({
      id: snapshot.id,
      main: snapshot.productImageUrl,
      en: snapshot.productImageUrlEn,
      textLocale: snapshot.imageTextLocale,
      localized: snapshot.localizedImages as PictureRow['localized'],
    }));
    expect(historyRows.flatMap((row) => planRow(row, emptyLibrary) ?? [])).toEqual([]);
  });
});
