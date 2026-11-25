import { describe, expect, it } from 'vitest';
import { groupLibraryItems, type LibraryItem } from './emoji-library-picture';

const item = (overrides: Partial<LibraryItem>): LibraryItem => ({
  id: 'id',
  name: 'Кефир',
  nameEn: 'Kefir',
  tags: [],
  imageUrl: 'https://utfs.io/f/x.webp',
  ...overrides,
});

describe('groupLibraryItems', () => {
  it('pairs the Russian and English versions of one picture', () => {
    const pictures = groupLibraryItems([
      item({
        id: 'en',
        locale: 'en',
        groupKey: 'text-001#2',
        imageUrl: 'https://utfs.io/f/en.webp',
      }),
      item({
        id: 'ru',
        locale: 'ru',
        groupKey: 'text-001#2',
        imageUrl: 'https://utfs.io/f/ru.webp',
      }),
    ]);

    expect(pictures).toEqual([
      expect.objectContaining({
        key: 'text-001#2',
        imageUrl: 'https://utfs.io/f/ru.webp',
        imageTextLocale: 'ru',
        localizedImages: { en: 'https://utfs.io/f/en.webp' },
      }),
    ]);
  });

  it('marks a text-free picture as none and gives it no other-language version', () => {
    const [picture] = groupLibraryItems([item({ id: 'a', locale: null, groupKey: 'batch-009#1' })]);

    expect(picture).toMatchObject({ imageTextLocale: 'none', localizedImages: {} });
  });

  it('keeps pictures without a group apart', () => {
    expect(groupLibraryItems([item({ id: 'a' }), item({ id: 'b' })])).toHaveLength(2);
  });

  it('never offers a lone English version as the main picture', () => {
    const [picture] = groupLibraryItems([
      item({ id: 'en', locale: 'en', groupKey: 'g', imageUrl: 'https://utfs.io/f/en.webp' }),
    ]);

    expect(picture).toMatchObject({
      imageUrl: null,
      imageTextLocale: null,
      localizedImages: { en: 'https://utfs.io/f/en.webp' },
    });
  });

  it('ignores a language that is not in the picture-language list', () => {
    const [picture] = groupLibraryItems([
      item({ id: 'ru', locale: 'ru', groupKey: 'g', imageUrl: 'https://utfs.io/f/ru.webp' }),
      item({ id: 'xx', locale: 'xx', groupKey: 'g', imageUrl: 'https://utfs.io/f/xx.webp' }),
    ]);

    expect(picture.localizedImages).toEqual({});
  });
});
