import { describe, expect, it } from 'vitest';
import { localizedName, localizedNamePair, namePair, namesOf } from './catalog-name';

describe('localizedName', () => {
  it('shows the English name in the English UI', () => {
    expect(localizedName({ name: 'Кабачок', nameEn: 'Zucchini' }, 'en')).toBe('Zucchini');
  });

  it('shows the Russian name in the Russian UI', () => {
    expect(localizedName({ name: 'Кабачок', nameEn: 'Zucchini' }, 'ru')).toBe('Кабачок');
  });

  it('falls back to the Russian name when English is missing or blank', () => {
    expect(localizedName({ name: 'Кабачок', nameEn: '  ' }, 'en')).toBe('Кабачок');
    expect(localizedName({ name: 'Кабачок' }, 'en')).toBe('Кабачок');
  });
});

describe('localizedNamePair for the catalogue', () => {
  const zucchini = { name: 'Кабачок', nameEn: 'Zucchini' };

  it('in Russian: the Russian name big, the English one small under it', () => {
    expect(localizedNamePair(zucchini, 'ru')).toEqual({
      primary: 'Кабачок',
      primaryLang: 'ru',
      secondary: 'Zucchini',
    });
  });

  it('in English: the English name only, no small line', () => {
    expect(localizedNamePair(zucchini, 'en')).toEqual({
      primary: 'Zucchini',
      primaryLang: 'en',
      secondary: undefined,
    });
  });

  it('in English without an English name: the Russian name, no small line', () => {
    expect(localizedNamePair({ name: 'Кабачок', nameEn: null }, 'en')).toEqual({
      primary: 'Кабачок',
      primaryLang: 'ru',
      secondary: undefined,
    });
  });

  it('draws no small line in Russian when English is blank or equals the Russian name', () => {
    expect(localizedNamePair({ name: 'Кабачок', nameEn: '  ' }, 'ru').secondary).toBeUndefined();
    expect(localizedNamePair({ name: 'Кабачок' }, 'ru').secondary).toBeUndefined();
    expect(
      localizedNamePair({ name: 'Ketchup', nameEn: ' Ketchup ' }, 'ru').secondary
    ).toBeUndefined();
  });

  it('builds the name map from an entity with Russian and English names', () => {
    expect(namesOf({ name: 'Кабачок', nameEn: 'Zucchini' })).toEqual({
      ru: 'Кабачок',
      en: 'Zucchini',
    });
  });
});

// The rule is about the interface language, not about Russian or English: a made-up language
// with its own name shows that name big and the English name small, with no Russian anywhere.
describe('namePair with an invented language', () => {
  const names = { ru: 'Кабачок', en: 'Zucchini', zz: 'Zuqqini' };

  it('shows the invented name big and the English name small', () => {
    expect(namePair(names, 'zz')).toEqual({
      primary: 'Zuqqini',
      primaryLang: 'zz',
      secondary: 'Zucchini',
    });
  });

  it('shows the Russian name big when the invented language has no name yet', () => {
    expect(namePair({ ru: 'Кабачок', en: 'Zucchini' }, 'zz')).toEqual({
      primary: 'Кабачок',
      primaryLang: 'ru',
      secondary: 'Zucchini',
    });
  });

  it('draws no small line when the invented name equals the English one', () => {
    expect(namePair({ ru: 'Кабачок', en: 'Zucchini', zz: 'Zucchini' }, 'zz')).toEqual({
      primary: 'Zucchini',
      primaryLang: 'zz',
      secondary: undefined,
    });
  });

  it('never draws a small line in the English UI', () => {
    expect(namePair(names, 'en').secondary).toBeUndefined();
  });
});
