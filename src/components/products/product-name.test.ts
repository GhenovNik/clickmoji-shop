import { describe, expect, it } from 'vitest';
import { productNameClassName } from './product-name';

describe('productNameClassName', () => {
  it('keeps short names at text-sm on two lines', () => {
    expect(productNameClassName('Кабачок')).toContain('text-sm md:text-base line-clamp-2');
  });

  it('shrinks a name with a word too long for a phone card', () => {
    expect(productNameClassName('Брюссельская капуста')).toContain(
      'text-xs md:text-sm line-clamp-3'
    );
  });

  it('shrinks a name with a ten-letter word, which needs three lines at text-sm', () => {
    expect(productNameClassName('Болгарский перец')).toContain('text-xs md:text-sm line-clamp-3');
  });

  it('shrinks a long multi-word name', () => {
    expect(productNameClassName('Средство для мытья посуды')).toContain(
      'text-xs md:text-sm line-clamp-3'
    );
  });

  it('breaks words with a hyphen instead of clipping them', () => {
    expect(productNameClassName('Кабачок')).toContain('hyphens-auto');
    expect(productNameClassName('Кабачок')).toContain('[overflow-wrap:anywhere]');
  });
});
