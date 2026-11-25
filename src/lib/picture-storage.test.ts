import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  historyPictureFields,
  legacyEnglishOf,
  localizedImagesForStorage,
} from './picture-storage';

const EN = 'https://utfs.io/f/kefir-en.webp';
const XX = 'https://utfs.io/f/kefir-xx.webp';

describe('localizedImagesForStorage', () => {
  it.each([
    ['no value', undefined],
    ['null', null],
    ['an empty object', {}],
    ['only blank URLs', { en: '  ' }],
    ['only the main language', { ru: 'https://utfs.io/f/kefir-ru.webp' }],
    ['a malformed value', 'en'],
  ])('stores SQL NULL for %s', (_name, raw) => {
    expect(localizedImagesForStorage(raw)).toBe(Prisma.DbNull);
  });

  it('keeps the picture languages of the list and drops the main language', () => {
    expect(localizedImagesForStorage({ en: EN, ru: 'https://utfs.io/f/kefir-ru.webp' })).toEqual({
      en: EN,
    });
  });

  it('keeps a language added to the list without changes elsewhere', () => {
    expect(localizedImagesForStorage({ en: EN, xx: XX }, ['ru', 'en', 'xx'])).toEqual({
      en: EN,
      xx: XX,
    });
  });

  it('drops a language that is not in the list', () => {
    expect(localizedImagesForStorage({ en: EN, xx: XX })).toEqual({ en: EN });
  });
});

describe('legacyEnglishOf', () => {
  it('mirrors the English entry into the legacy English column', () => {
    expect(legacyEnglishOf({ en: EN })).toBe(EN);
  });

  it('is null without an English entry', () => {
    expect(legacyEnglishOf({})).toBeNull();
    expect(legacyEnglishOf({ xx: XX })).toBeNull();
  });
});

describe('historyPictureFields', () => {
  it('copies the main picture, its text language and the dictionary into the history row', () => {
    expect(
      historyPictureFields({
        imageUrl: 'https://utfs.io/f/kefir-ru.webp',
        imageTextLocale: 'ru',
        localizedImages: { en: EN },
      })
    ).toEqual({
      productImageUrl: 'https://utfs.io/f/kefir-ru.webp',
      imageTextLocale: 'ru',
      localizedImages: { en: EN },
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
