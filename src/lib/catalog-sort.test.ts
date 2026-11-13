// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sortByDisplayedName } from './catalog-sort';

const products = [
  { id: 'watermelon', name: 'Арбуз', nameEn: 'Watermelon' },
  { id: 'banana', name: 'Банан', nameEn: 'Banana' },
  { id: 'cherry', name: 'Вишня', nameEn: null },
  { id: 'apple', name: 'Яблоко', nameEn: 'Apple' },
];

describe('sortByDisplayedName', () => {
  it('en: sorts by the displayed name with an English case-insensitive comparison', () => {
    const sorted = sortByDisplayedName(products, 'en');

    expect(sorted.map((item) => item.id)).toEqual(['apple', 'banana', 'watermelon', 'cherry']);
  });

  it('ru: keeps the database order', () => {
    expect(sortByDisplayedName(products, 'ru')).toBe(products);
  });

  it('an unrecognised language keeps the database order', () => {
    expect(sortByDisplayedName(products, 'de')).toBe(products);
  });

  it('en: sorting is stable for equal displayed names', () => {
    const ties = [
      { id: 'first', name: 'Персидская', nameEn: 'Apple' },
      { id: 'second', name: 'Яблоко', nameEn: 'apple' },
    ];

    expect(sortByDisplayedName(ties, 'en').map((item) => item.id)).toEqual(['first', 'second']);
  });
});
