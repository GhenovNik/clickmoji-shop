import { describe, expect, it } from 'vitest';
import {
  applyWrites,
  countRows,
  planModel,
  planRow,
  TEXT_LOCALE_NONE,
  type LibraryLocales,
  type PictureRow,
} from './localized-pictures-backfill';

const library: LibraryLocales = new Map<string, string | null>([
  ['https://lib.example/ru.webp', 'ru'],
  ['https://lib.example/none.webp', null],
  ['https://lib.example/en.webp', 'en'],
]);

function row(overrides: Partial<PictureRow> & { id: string }): PictureRow {
  return { main: null, en: null, textLocale: null, localized: null, ...overrides };
}

describe('planRow: English copy', () => {
  it('copies a non-null legacy English URL to localizedImages.en', () => {
    const write = planRow(row({ id: 'a', en: 'https://en.example/a.webp' }), library);
    expect(write).toEqual({ id: 'a', localizedImages: { en: 'https://en.example/a.webp' } });
  });

  it('keeps other dictionary keys when it adds en', () => {
    const write = planRow(
      row({
        id: 'a',
        en: 'https://en.example/a.webp',
        localized: { es: 'https://es.example/a.webp' },
      }),
      library
    );
    expect(write?.localizedImages).toEqual({
      es: 'https://es.example/a.webp',
      en: 'https://en.example/a.webp',
    });
  });

  it('overwrites a stale en with the legacy value so a rerun catches later edits', () => {
    const write = planRow(
      row({
        id: 'a',
        en: 'https://en.example/new.webp',
        localized: { en: 'https://en.example/old.webp', es: 'https://es.example/a.webp' },
      }),
      library
    );
    expect(write?.localizedImages).toEqual({
      en: 'https://en.example/new.webp',
      es: 'https://es.example/a.webp',
    });
  });

  it('removes a stale en when the legacy English URL was cleared and keeps other locales', () => {
    const write = planRow(
      row({
        id: 'a',
        en: null,
        localized: { en: 'https://en.example/old.webp', es: 'https://es.example/a.webp' },
      }),
      library
    );
    expect(write).toEqual({ id: 'a', localizedImages: { es: 'https://es.example/a.webp' } });
  });

  it('stores SQL Null when removing the last key leaves an empty dictionary', () => {
    const write = planRow(
      row({ id: 'a', en: null, localized: { en: 'https://en.example/old.webp' } }),
      library
    );
    expect(write).toEqual({ id: 'a', localizedImages: null });
  });

  it('writes nothing when the legacy English URL is null and no en is stored', () => {
    expect(planRow(row({ id: 'a', en: null, localized: null }), library)).toBeNull();
    expect(
      planRow(row({ id: 'a', en: null, localized: { es: 'https://es.example/a.webp' } }), library)
    ).toBeNull();
    expect(planRow(row({ id: 'a', en: null, localized: {} }), library)).toBeNull();
  });

  it('treats a null localizedImages as an empty dictionary', () => {
    const write = planRow(
      row({ id: 'a', en: 'https://en.example/a.webp', localized: null }),
      library
    );
    expect(write?.localizedImages).toEqual({ en: 'https://en.example/a.webp' });
  });

  it('fails closed when localizedImages is not a JSON object', () => {
    expect(() =>
      planRow(row({ id: 'bad', en: 'https://en.example/a.webp', localized: ['x'] }), library)
    ).toThrow(/row bad.*not a JSON object/);
    expect(() =>
      planRow(row({ id: 'bad', en: 'https://en.example/a.webp', localized: 'text' }), library)
    ).toThrow(/row bad/);
  });
});

describe('planRow: text locale of the main picture', () => {
  it('takes the library locale for an exact URL match', () => {
    expect(planRow(row({ id: 'a', main: 'https://lib.example/ru.webp' }), library)).toEqual({
      id: 'a',
      imageTextLocale: 'ru',
    });
  });

  it('turns a matched library row with null locale into "none"', () => {
    expect(planRow(row({ id: 'a', main: 'https://lib.example/none.webp' }), library)).toEqual({
      id: 'a',
      imageTextLocale: TEXT_LOCALE_NONE,
    });
  });

  it('leaves the value null when the URL is not in the library', () => {
    expect(planRow(row({ id: 'a', main: 'https://elsewhere.example/x.webp' }), library)).toBeNull();
  });

  it('does not match a URL that differs only in case or whitespace', () => {
    expect(planRow(row({ id: 'a', main: 'https://LIB.example/ru.webp' }), library)).toBeNull();
    expect(planRow(row({ id: 'a', main: 'https://lib.example/ru.webp ' }), library)).toBeNull();
  });

  it('does not invent a text locale when the main picture is null', () => {
    expect(planRow(row({ id: 'a', main: null, en: null }), library)).toBeNull();
  });

  it('clears a stale locale when the main URL was changed to an unknown address', () => {
    expect(
      planRow(
        row({ id: 'a', main: 'https://elsewhere.example/new.webp', textLocale: 'ru' }),
        library
      )
    ).toEqual({ id: 'a', imageTextLocale: null });
  });

  it('clears a stale locale when the main URL was removed', () => {
    expect(planRow(row({ id: 'a', main: null, textLocale: 'none' }), library)).toEqual({
      id: 'a',
      imageTextLocale: null,
    });
  });

  it('writes nothing for an unknown or absent main URL that is already unmarked', () => {
    expect(
      planRow(row({ id: 'a', main: 'https://elsewhere.example/x.webp', textLocale: null }), library)
    ).toBeNull();
    expect(planRow(row({ id: 'a', main: null, textLocale: null }), library)).toBeNull();
  });

  it('re-derives the locale when a changed URL moves to another library locale', () => {
    expect(
      planRow(row({ id: 'a', main: 'https://lib.example/en.webp', textLocale: 'ru' }), library)
    ).toEqual({ id: 'a', imageTextLocale: 'en' });
  });

  it('writes nothing when the marking already matches the library', () => {
    expect(
      planRow(row({ id: 'a', main: 'https://lib.example/en.webp', textLocale: 'en' }), library)
    ).toBeNull();
  });
});

describe('planModel: counts and rerun', () => {
  const rows: PictureRow[] = [
    row({
      id: 'ru-with-en',
      main: 'https://lib.example/ru.webp',
      en: 'https://en.example/1.webp',
      localized: { es: 'https://es.example/1.webp' },
    }),
    row({ id: 'none', main: 'https://lib.example/none.webp' }),
    row({
      id: 'unknown',
      main: 'https://elsewhere.example/2.webp',
      en: 'https://en.example/2.webp',
    }),
    row({ id: 'empty' }),
  ];

  it('reports before counts, a projection and the writes', () => {
    const plan = planModel('product', rows, library);
    expect(plan.before).toEqual({
      rows: 4,
      withMainPicture: 3,
      withEnglishUrl: 2,
      englishCopyMissing: 2,
      unmarked: 3,
      textNone: 0,
      textLocale: 0,
    });
    expect(plan.writes.map((write) => write.id)).toEqual(['ru-with-en', 'none', 'unknown']);
    expect(plan.writeCounts).toEqual({ rows: 3, textLocale: 2, english: 2 });
    expect(plan.projectedAfter).toEqual({
      rows: 4,
      withMainPicture: 3,
      withEnglishUrl: 2,
      englishCopyMissing: 0,
      unmarked: 1,
      textNone: 1,
      textLocale: 1,
    });
  });

  it('plans zero writes on the projected state (second run is a no-op)', () => {
    const plan = planModel('product', rows, library);
    const again = planModel('product', applyWrites(rows, plan.writes), library);
    expect(again.writes).toEqual([]);
    expect(again.projectedAfter).toEqual(plan.projectedAfter);
  });

  it('projects cleared values (null) instead of keeping the old ones', () => {
    const stale = [
      row({
        id: 'edited',
        main: 'https://elsewhere.example/new.webp',
        en: null,
        textLocale: 'ru',
        localized: { en: 'https://en.example/old.webp', es: 'https://es.example/a.webp' },
      }),
    ];
    const plan = planModel('product', stale, library);
    expect(plan.writes).toEqual([
      { id: 'edited', imageTextLocale: null, localizedImages: { es: 'https://es.example/a.webp' } },
    ]);
    expect(plan.projectedAfter).toMatchObject({
      unmarked: 1,
      englishCopyMissing: 0,
      textLocale: 0,
    });
    expect(applyWrites(stale, plan.writes)[0]).toMatchObject({
      textLocale: null,
      localized: { es: 'https://es.example/a.webp' },
    });
  });

  it('a rerun after legacy edits plans zero writes once the writes are applied', () => {
    const edited = [
      row({
        id: 'edited',
        main: 'https://elsewhere.example/new.webp',
        en: null,
        textLocale: 'ru',
        localized: { en: 'https://en.example/old.webp' },
      }),
      row({ id: 'kept', main: 'https://lib.example/ru.webp', en: 'https://en.example/k.webp' }),
    ];
    const first = planModel('product', edited, library);
    const second = planModel('product', applyWrites(edited, first.writes), library);
    expect(second.writes).toEqual([]);
  });

  it('counts unmarked only where a main picture exists without a marking', () => {
    const counts = countRows([
      row({ id: 'no-main' }),
      row({ id: 'main', main: 'https://x.example/a' }),
    ]);
    expect(counts.unmarked).toBe(1);
  });
});
