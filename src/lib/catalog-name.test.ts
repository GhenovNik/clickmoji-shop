import { describe, expect, it } from 'vitest';
import { localizedName } from './catalog-name';

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
