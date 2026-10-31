import { describe, expect, it } from 'vitest';
import {
  cleanProductName,
  extractProductNote,
  isValidEmoji,
  mergeNotes,
  normalizeProductName,
  selectCatalogForPrompt,
  splitProductNameAndNote,
} from '@/lib/product-name';

describe('normalizeProductName', () => {
  it('drops quantities, units, numbers, punctuation, case and ё', () => {
    expect(normalizeProductName('Молоко 2.5%')).toBe('молоко');
    expect(normalizeProductName('Сливки 33%')).toBe('сливки');
    expect(normalizeProductName('Ёлка 20 %')).toBe('елка');
    expect(normalizeProductName('Кефир 1 л')).toBe('кефир');
    expect(normalizeProductName('Сыр 2 шт.')).toBe('сыр');
    expect(normalizeProductName('Хлеб, белый!')).toBe('хлеб белый');
    expect(normalizeProductName('MILK 2.5%')).toBe('milk');
    expect(normalizeProductName('   ')).toBe('');
  });
});

describe('quantity notes and cleaned names', () => {
  it('moves quantities and attributes out of the name', () => {
    expect(splitProductNameAndNote('сливки 33%')).toEqual({ name: 'Сливки', note: '33%' });
    expect(splitProductNameAndNote('сметана 20%')).toEqual({ name: 'Сметана', note: '20%' });
    expect(splitProductNameAndNote('Кефир 1 л')).toEqual({ name: 'Кефир', note: '1 л' });
    expect(splitProductNameAndNote('Молоко (2.5%)')).toEqual({
      name: 'Молоко',
      note: '2.5%',
    });
    expect(splitProductNameAndNote('Хлеб белый')).toEqual({ name: 'Хлеб белый', note: undefined });
  });

  it('capitalises the first letter and keeps the rest of the shopper word', () => {
    expect(cleanProductName(' молоко ')).toBe('Молоко');
    expect(cleanProductName('хлеб белый')).toBe('Хлеб белый');
    expect(cleanProductName('33%')).toBe('');
  });

  it('collects notes in order without duplicates', () => {
    expect(extractProductNote('Сыр 2 шт. (50%)')).toBe('2 шт, 50%');
    expect(mergeNotes('33%', undefined, ' 33% ', '2 шт')).toBe('33%, 2 шт');
    expect(mergeNotes(undefined, ' ')).toBeUndefined();
  });
});

describe('isValidEmoji', () => {
  it('accepts one Unicode emoji, including modifiers and ZWJ sequences', () => {
    for (const value of ['🥛', '🧂', '📦', '👍🏽', '👨‍👩‍👧', '❤️']) {
      expect(isValidEmoji(value)).toBe(true);
    }
  });

  it('rejects empty, textual and multi-part values', () => {
    for (const value of ['', 'milk', '🥛 milk', '📦📦', 'not-an-emoji', 7, null]) {
      expect(isValidEmoji(value)).toBe(false);
    }
  });
});

describe('selectCatalogForPrompt', () => {
  const product = (id: string, name: string, nameEn: string) => ({ id, name, nameEn });

  it('passes a catalog of up to the limit through unchanged', () => {
    const catalog = [product('1', 'Молоко', 'Milk'), product('2', 'Хлеб', 'Bread')];

    expect(selectCatalogForPrompt(catalog, 'Молоко', 400)).toEqual(catalog);
  });

  it('keeps only products sharing a word with the text when there are more than 400', () => {
    const catalog = Array.from({ length: 401 }, (_, index) =>
      product(`p-${index}`, `Товар ${index}`, `Product ${index}`)
    );
    catalog.push(product('milk', 'Молоко', 'Milk'));

    const selected = selectCatalogForPrompt(catalog, 'Молоко 2.5%', 400);

    expect(catalog.length).toBeGreaterThan(400);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('milk');
  });

  it('caps the filtered list at the limit, best overlap first', () => {
    const catalog = Array.from({ length: 450 }, (_, index) =>
      product(`bread-${index}`, 'Хлеб белый', `White bread ${index}`)
    );

    const selected = selectCatalogForPrompt(catalog, 'Хлеб', 400);

    expect(selected).toHaveLength(400);
    expect(selected.every((entry) => entry.name === 'Хлеб белый')).toBe(true);
  });
});
