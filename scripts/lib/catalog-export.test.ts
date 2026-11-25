import { describe, expect, it } from 'vitest';
import { parseCatalogExport } from './catalog-export';

describe('catalogue export parser (AGE-1667 C3, Ya3)', () => {
  it('parses products vs all slots and rejects malformed exports', () => {
    const sample = {
      source: 'test export',
      categories: [
        {
          name: 'Овощи',
          nameEn: 'Vegetables',
          imageUrl: 'https://example.test/cat.webp',
          products: [
            {
              id: 'p1',
              name: 'Морковь',
              nameEn: 'Carrot',
              imageUrl: 'https://example.test/p1.webp',
              imageUrlEn: 'https://example.test/p1-en.webp',
              variants: [
                {
                  id: 'v1',
                  name: 'Морковь мытая',
                  nameEn: 'Washed carrot',
                  imageUrl: 'https://example.test/v1.webp',
                },
              ],
            },
            {
              name: 'Лук',
              nameEn: 'Onion',
              imageUrl: null,
              imageUrlEn: null,
              variants: [],
            },
          ],
        },
      ],
    };

    const productsOnly = parseCatalogExport(sample, 'products');
    expect(productsOnly.entries).toHaveLength(1);
    expect(productsOnly.entries[0]).toMatchObject({ id: 'p1', kind: 'product', field: 'imageUrl' });
    expect(productsOnly.counts).toEqual({
      categories: 1,
      products: 2,
      variants: 1,
      productPrimary: 1,
      productEn: 1,
      variantPrimary: 1,
      variantEn: 0,
      categoryPrimary: 1,
      totalSlots: 4,
    });

    const allSlots = parseCatalogExport(sample, 'all');
    expect(allSlots.entries).toHaveLength(4);

    expect(() => parseCatalogExport([])).toThrow('top-level JSON object');
    expect(() => parseCatalogExport({})).toThrow('missing "categories" array');
    expect(() => parseCatalogExport({ categories: [{ name: '', products: [] }] })).toThrow(
      'missing string categories[0].name'
    );
  });

  const exportOf = (product: Record<string, unknown>, variant?: Record<string, unknown>) => ({
    categories: [
      {
        name: 'Молочные',
        products: [
          {
            id: 'p1',
            name: 'Кефир',
            nameEn: 'Kefir',
            imageUrl: 'https://example.test/kefir.webp',
            ...product,
            variants: variant
              ? [{ id: 'v1', name: 'Кефир 1%', nameEn: 'Kefir 1%', ...variant }]
              : [],
          },
        ],
      },
    ],
  });
  const englishUrls = (raw: unknown) =>
    parseCatalogExport(raw, 'all')
      .entries.filter((entry) => entry.field === 'englishPicture')
      .map((entry) => `${entry.kind}:${entry.url}`);

  it('reads the English picture from the dictionary of an export taken after the dictionary', () => {
    const raw = exportOf(
      {
        localizedImages: {
          en: 'https://example.test/kefir-en.webp',
          es: 'https://example.test/es.webp',
        },
      },
      { localizedImages: { en: 'https://example.test/v-en.webp' } }
    );

    expect(englishUrls(raw)).toEqual([
      'product:https://example.test/kefir-en.webp',
      'variant:https://example.test/v-en.webp',
    ]);
    expect(parseCatalogExport(raw, 'all').counts).toMatchObject({ productEn: 1, variantEn: 1 });
  });

  it('still reads the legacy English field of an export taken before the dictionary', () => {
    const raw = exportOf(
      { imageUrlEn: 'https://example.test/kefir-old.webp' },
      { imageUrlEn: 'https://example.test/v-old.webp' }
    );

    expect(englishUrls(raw)).toEqual([
      'product:https://example.test/kefir-old.webp',
      'variant:https://example.test/v-old.webp',
    ]);
  });

  it('prefers the dictionary entry when an export carries both', () => {
    const raw = exportOf({
      imageUrlEn: 'https://example.test/stale.webp',
      localizedImages: { en: 'https://example.test/current.webp' },
    });

    expect(englishUrls(raw)).toEqual(['product:https://example.test/current.webp']);
  });

  it('rejects a dictionary that is not an object and counts no English picture without one', () => {
    expect(() => parseCatalogExport(exportOf({ localizedImages: ['x'] }))).toThrow(
      'localizedImages must be an object'
    );
    expect(
      englishUrls(exportOf({ localizedImages: { es: 'https://example.test/es.webp' } }))
    ).toEqual([]);
  });
});
