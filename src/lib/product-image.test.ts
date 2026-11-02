import { describe, expect, it } from 'vitest';
import { productImageUrl } from './product-image';

const RU = 'https://utfs.io/f/kefir-ru.webp';
const EN = 'https://utfs.io/f/kefir-en.webp';

describe('productImageUrl', () => {
  it('shows the English picture in the English UI', () => {
    expect(productImageUrl({ imageUrl: RU, imageUrlEn: EN }, 'en')).toBe(EN);
  });

  it('shows the Russian picture in the Russian UI', () => {
    expect(productImageUrl({ imageUrl: RU, imageUrlEn: EN }, 'ru')).toBe(RU);
  });

  it('falls back to the main picture when there is no English one', () => {
    expect(productImageUrl({ imageUrl: RU, imageUrlEn: null }, 'en')).toBe(RU);
    expect(productImageUrl({ imageUrl: RU }, 'en')).toBe(RU);
  });

  it('has nothing to show for a product without a picture', () => {
    expect(productImageUrl({ imageUrl: null, imageUrlEn: null }, 'ru')).toBeNull();
  });
});
