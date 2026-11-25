import { describe, expect, it } from 'vitest';
import { localizedImagesOf, productImageUrl, type ProductPicture } from './product-image';
import { IMAGE_LANGUAGES } from './image-languages';

const RU = 'https://utfs.io/f/kefir-ru.webp';
const EN = 'https://utfs.io/f/kefir-en.webp';
const ES = 'https://utfs.io/f/kefir-es.webp';
const DE = 'https://utfs.io/f/kefir-de.webp';
const XX = 'https://utfs.io/f/kefir-xx.webp';

type Case = {
  step: string;
  picture: ProductPicture;
  locale: string;
  expected: string | null;
};

// The five steps of the selection rule (plan AGE-1667, section 2). Null, empty and 'none' all mean
// "no text on the main picture"; an unlabelled main picture therefore behaves like 'none'.
const steps: Case[] = [
  {
    step: '1. dictionary entry for the language wins over the main picture',
    picture: { imageUrl: RU, imageTextLocale: 'ru', localizedImages: { en: EN } },
    locale: 'en',
    expected: EN,
  },
  {
    step: '2. text-free main picture serves any language',
    picture: { imageUrl: RU, imageTextLocale: 'none' },
    locale: 'en',
    expected: RU,
  },
  {
    step: '2. main picture in the same language as the UI',
    picture: { imageUrl: EN, imageTextLocale: 'en' },
    locale: 'en',
    expected: EN,
  },
  {
    step: '3. fallback language entry serves a language with no picture of its own',
    picture: { imageUrl: RU, imageTextLocale: 'ru', localizedImages: { en: EN } },
    locale: 'es',
    expected: EN,
  },
  {
    step: '3. fallback language main picture serves a language with no picture of its own',
    picture: { imageUrl: EN, imageTextLocale: 'en' },
    locale: 'es',
    expected: EN,
  },
  {
    step: '4. main picture with foreign text is the last resort',
    picture: { imageUrl: RU, imageTextLocale: 'ru' },
    locale: 'en',
    expected: RU,
  },
  {
    step: '4. English main picture is shown in Russian when nothing else exists',
    picture: { imageUrl: EN, imageTextLocale: 'en' },
    locale: 'ru',
    expected: EN,
  },
  {
    step: '5. no picture at all means an emoji',
    picture: { imageUrl: null },
    locale: 'en',
    expected: null,
  },
  {
    step: '5. a dictionary entry for another language does not serve this one',
    picture: { imageUrl: null, localizedImages: { en: EN } },
    locale: 'ru',
    expected: null,
  },
];

describe('productImageUrl: the five selection steps', () => {
  it.each(steps)('$step', ({ picture, locale, expected }) => {
    expect(productImageUrl(picture, locale)).toBe(expected);
  });
});

describe('productImageUrl: unlabelled and empty markers behave like none', () => {
  const unlabelledCases: Array<[string, ProductPicture]> = [
    ['null marker', { imageUrl: RU, imageTextLocale: null }],
    ['missing marker', { imageUrl: RU }],
    ['empty marker', { imageUrl: RU, imageTextLocale: '' }],
    ['none marker', { imageUrl: RU, imageTextLocale: 'none' }],
  ];

  it.each(unlabelledCases)('%s: the main picture serves English', (_name, picture) => {
    expect(productImageUrl(picture, 'en')).toBe(RU);
  });

  it.each(unlabelledCases)('%s: the main picture serves Russian', (_name, picture) => {
    expect(productImageUrl(picture, 'ru')).toBe(RU);
  });

  it('gives the same result for null and none in every language', () => {
    for (const locale of ['ru', 'en', 'es', 'xx']) {
      expect(productImageUrl({ imageUrl: RU, imageTextLocale: null }, locale)).toBe(
        productImageUrl({ imageUrl: RU, imageTextLocale: 'none' }, locale)
      );
    }
  });

  it('treats empty and blank URLs as no picture', () => {
    expect(productImageUrl({ imageUrl: '' }, 'en')).toBeNull();
    expect(productImageUrl({ imageUrl: '   ', localizedImages: { en: '  ' } }, 'en')).toBeNull();
  });

  it('ignores malformed dictionaries instead of guessing', () => {
    for (const localizedImages of [null, undefined, 'x', ['a'], { en: null }, { en: 3 }]) {
      expect(localizedImagesOf(localizedImages)).toEqual({});
    }
  });
});

describe('productImageUrl: a language list entry is enough to add a language', () => {
  it('selects a picture for a language that is not in the list', () => {
    expect(productImageUrl({ imageUrl: RU, localizedImages: { xx: XX } }, 'xx')).toBe(XX);
  });

  it('keeps dictionary entries of languages from the list it is given', () => {
    const raw = { en: EN, xx: XX };
    expect(localizedImagesOf(raw, [...IMAGE_LANGUAGES, 'xx'])).toEqual({ en: EN, xx: XX });
    expect(localizedImagesOf(raw, IMAGE_LANGUAGES)).toEqual({ en: EN });
  });
});

describe('productImageUrl: availability (offline, plan section 7)', () => {
  it('serves the Russian main picture in English when only it is available', () => {
    const isAvailable = (url: string) => url === RU;
    const picture: ProductPicture = {
      imageUrl: RU,
      imageTextLocale: 'none',
      localizedImages: { en: EN },
    };
    expect(productImageUrl(picture, 'en', { isAvailable })).toBe(RU);
  });

  it('serves the Russian picture in Russian when only it is available', () => {
    const isAvailable = (url: string) => url === RU;
    expect(
      productImageUrl({ imageUrl: RU, localizedImages: { en: EN } }, 'ru', { isAvailable })
    ).toBe(RU);
  });

  it('gives nothing when no picture of the product is available', () => {
    const isAvailable = () => false;
    expect(
      productImageUrl({ imageUrl: RU, localizedImages: { en: EN } }, 'en', { isAvailable })
    ).toBeNull();
  });

  it('gives nothing when the product has no pictures at all', () => {
    const isAvailable = () => true;
    expect(productImageUrl({ imageUrl: null }, 'en', { isAvailable })).toBeNull();
  });

  it('takes any available picture of the product when no picture of the chain is available', () => {
    const isAvailable = (url: string) => url === DE;
    const picture: ProductPicture = {
      imageUrl: RU,
      imageTextLocale: 'ru',
      localizedImages: { en: EN, de: DE },
    };
    expect(productImageUrl(picture, 'en', { isAvailable })).toBe(DE);
  });

  it('keeps the chain order among available pictures', () => {
    const isAvailable = () => true;
    const picture: ProductPicture = {
      imageUrl: RU,
      imageTextLocale: 'ru',
      localizedImages: { en: EN },
    };
    expect(productImageUrl(picture, 'en', { isAvailable })).toBe(EN);
  });

  it('without the availability option the result is the chain result', () => {
    const picture: ProductPicture = {
      imageUrl: RU,
      imageTextLocale: 'ru',
      localizedImages: { en: EN },
    };
    expect(productImageUrl(picture, 'en')).toBe(EN);
    expect(productImageUrl(picture, 'en', {})).toBe(EN);
  });
});

describe('productImageUrl: the two catalogue languages keep their display', () => {
  it('shows the English picture in the English UI and the Russian one in the Russian UI', () => {
    const picture: ProductPicture = {
      imageUrl: RU,
      imageTextLocale: 'ru',
      localizedImages: { en: EN },
    };
    expect(productImageUrl(picture, 'en')).toBe(EN);
    expect(productImageUrl(picture, 'ru')).toBe(RU);
  });

  it('falls back to the main picture when there is no English one', () => {
    expect(productImageUrl({ imageUrl: RU, localizedImages: null }, 'en')).toBe(RU);
    expect(productImageUrl({ imageUrl: RU }, 'en')).toBe(RU);
  });

  it('has nothing to show for a product without a picture', () => {
    expect(productImageUrl({ imageUrl: null, localizedImages: null }, 'ru')).toBeNull();
  });
});
