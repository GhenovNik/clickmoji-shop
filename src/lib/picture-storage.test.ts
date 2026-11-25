import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  historyPictureFields,
  legacyEnglishOf,
  localizedImagesForStorage,
  editsEnglish,
  mergeLocalizedImages,
  pictureEditOf,
} from './picture-storage';

const EN = 'https://utfs.io/f/kefir-en.webp';
const RU = 'https://utfs.io/f/kefir-ru.webp';
const ES = 'https://utfs.io/f/kefir-es.webp';

describe('localizedImagesForStorage', () => {
  it.each([
    ['no value', undefined],
    ['null', null],
    ['an empty object', {}],
    ['only blank URLs', { en: '  ' }],
    ['a malformed value', 'en'],
    ['an array', [EN]],
  ])('stores SQL NULL for %s', (_name, raw) => {
    expect(localizedImagesForStorage(raw)).toBe(Prisma.DbNull);
  });

  it('keeps every entry with a URL, whatever its language', () => {
    expect(localizedImagesForStorage({ en: EN, ru: RU, es: ES, blank: ' ' })).toEqual({
      en: EN,
      ru: RU,
      es: ES,
    });
  });
});

describe('mergeLocalizedImages', () => {
  it('sets the languages the edit names and removes the ones it nulls', () => {
    expect(mergeLocalizedImages({ en: EN, ru: RU }, { ru: 'https://utfs.io/f/new.webp' })).toEqual({
      en: EN,
      ru: 'https://utfs.io/f/new.webp',
    });
    expect(mergeLocalizedImages({ en: EN, ru: RU }, { en: null })).toEqual({ ru: RU });
    // A blank string is a removal too, never a stored empty address.
    expect(mergeLocalizedImages({ en: EN }, { en: '  ' })).toEqual({});
  });

  it('keeps a language the edit does not name: an absent key is "not touched", not "removed"', () => {
    expect(mergeLocalizedImages({ en: EN, ru: RU }, {})).toEqual({ en: EN, ru: RU });
    expect(mergeLocalizedImages({ en: EN }, { ru: RU })).toEqual({ en: EN, ru: RU });
  });

  it('keeps an entry of a language the list does not cover, whatever the edit says', () => {
    expect(mergeLocalizedImages({ en: EN, es: ES }, { en: null })).toEqual({ es: ES });
    // An edit cannot overwrite, remove or add a language outside the list.
    expect(mergeLocalizedImages({ es: ES }, { es: EN, fr: EN })).toEqual({ es: ES });
    expect(mergeLocalizedImages({ es: ES }, { es: null })).toEqual({ es: ES });
    expect(mergeLocalizedImages(null, { fr: EN })).toEqual({});
  });

  it('treats a missing or malformed stored dictionary as empty', () => {
    expect(mergeLocalizedImages(null, { en: EN })).toEqual({ en: EN });
    expect(mergeLocalizedImages('broken', { en: EN })).toEqual({ en: EN });
  });

  it('ignores a malformed edit: nothing is removed by a request that cannot be read', () => {
    for (const edit of [undefined, null, 'en', [EN], 7]) {
      expect(mergeLocalizedImages({ en: EN }, edit)).toEqual({ en: EN });
    }
    // A malformed value of one language leaves that language as stored.
    expect(mergeLocalizedImages({ en: EN, ru: RU }, { en: 5, ru: { url: RU } })).toEqual({
      en: EN,
      ru: RU,
    });
  });
});

describe('pictureEditOf and editsEnglish', () => {
  it('reads the languages of the list and drops the rest', () => {
    expect(pictureEditOf({ en: EN, ru: null, es: ES, bad: 1, empty: '' })).toEqual({
      en: EN,
      ru: null,
    });
    expect(pictureEditOf({ en: 5 })).toEqual({});
    expect(pictureEditOf(null)).toBeNull();
    expect(pictureEditOf([EN])).toBeNull();
  });

  it('says English is edited only when the edit names it', () => {
    expect(editsEnglish({ en: EN })).toBe(true);
    expect(editsEnglish({ en: null })).toBe(true);
    expect(editsEnglish({ ru: RU })).toBe(false);
    expect(editsEnglish({})).toBe(false);
    expect(editsEnglish({ en: 5 })).toBe(false);
    expect(editsEnglish(undefined)).toBe(false);
  });
});

describe('legacyEnglishOf', () => {
  it('mirrors the English entry into the legacy English column', () => {
    expect(legacyEnglishOf({ en: EN })).toBe(EN);
  });

  it('is null without an English entry', () => {
    expect(legacyEnglishOf({})).toBeNull();
    expect(legacyEnglishOf({ es: ES })).toBeNull();
  });
});

describe('historyPictureFields', () => {
  it('copies the main picture, its text language and the whole dictionary into the history row', () => {
    expect(
      historyPictureFields({
        imageUrl: RU,
        imageTextLocale: 'ru',
        localizedImages: { en: EN, es: ES },
      })
    ).toEqual({
      productImageUrl: RU,
      imageTextLocale: 'ru',
      localizedImages: { en: EN, es: ES },
      productImageUrlEn: EN,
    });
  });

  it('keeps an unlabelled picture unlabelled and stores no dictionary when there is none', () => {
    expect(
      historyPictureFields({ imageUrl: null, imageTextLocale: null, localizedImages: null })
    ).toEqual({
      productImageUrl: null,
      imageTextLocale: null,
      localizedImages: Prisma.DbNull,
      productImageUrlEn: null,
    });
  });
});
