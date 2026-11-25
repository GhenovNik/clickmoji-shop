import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  historyPictureFields,
  legacyEnglishOf,
  localizedImagesForStorage,
  mergeLocalizedImages,
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
  it('replaces the listed languages with the edit and removes an absent one', () => {
    expect(mergeLocalizedImages({ en: EN, ru: RU }, { ru: 'https://utfs.io/f/new.webp' })).toEqual({
      ru: 'https://utfs.io/f/new.webp',
    });
    expect(mergeLocalizedImages({ en: EN }, {})).toEqual({});
  });

  it('keeps an entry of a language the list does not cover, whatever the edit says', () => {
    expect(mergeLocalizedImages({ en: EN, es: ES }, { en: EN })).toEqual({ en: EN, es: ES });
    expect(mergeLocalizedImages({ en: EN, es: ES }, {})).toEqual({ es: ES });
    // An edit cannot overwrite or add a language outside the list.
    expect(mergeLocalizedImages({ es: ES }, { es: EN, fr: EN })).toEqual({ es: ES });
    expect(mergeLocalizedImages(null, { fr: EN })).toEqual({});
  });

  it('treats a missing or malformed stored dictionary as empty', () => {
    expect(mergeLocalizedImages(null, { en: EN })).toEqual({ en: EN });
    expect(mergeLocalizedImages('broken', { en: EN })).toEqual({ en: EN });
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
