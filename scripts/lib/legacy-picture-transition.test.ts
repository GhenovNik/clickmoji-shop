// @vitest-environment node
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { readVisibleSnapshotPictures, withLegacyEnglish } from './legacy-picture-transition';

describe('withLegacyEnglish', () => {
  it('fills the English entry from the legacy column when the dictionary has none', () => {
    expect(withLegacyEnglish({ localizedImages: null, imageUrlEn: '/legacy.webp' })).toEqual({
      en: '/legacy.webp',
    });
    expect(
      withLegacyEnglish({ localizedImages: { ru: '/ru.webp' }, imageUrlEn: '/l.webp' })
    ).toEqual({ ru: '/ru.webp', en: '/l.webp' });
  });

  it('lets the dictionary win and keeps every language', () => {
    expect(
      withLegacyEnglish({
        localizedImages: { en: '/dictionary.webp', xx: '/xx.webp' },
        imageUrlEn: '/legacy.webp',
      })
    ).toEqual({ en: '/dictionary.webp', xx: '/xx.webp' });
  });

  it.each([null, undefined, '', '   '])('ignores an empty legacy value (%j)', (legacy) => {
    expect(withLegacyEnglish({ localizedImages: { ru: '/ru.webp' }, imageUrlEn: legacy })).toEqual({
      ru: '/ru.webp',
    });
  });

  it('treats a blank English entry of the dictionary as missing', () => {
    expect(withLegacyEnglish({ localizedImages: { en: ' ' }, imageUrlEn: '/legacy.webp' })).toEqual(
      {
        en: '/legacy.webp',
      }
    );
  });

  it('does not change its input', () => {
    const localizedImages = { ru: '/ru.webp' };
    withLegacyEnglish({ localizedImages, imageUrlEn: '/legacy.webp' });
    expect(localizedImages).toEqual({ ru: '/ru.webp' });
  });
});

describe('readVisibleSnapshotPictures', () => {
  const rows = [
    {
      id: 'milk',
      imageUrl: '/milk.webp',
      imageTextLocale: 'ru',
      localizedImages: null,
      imageUrlEn: '/milk-en.webp',
    },
    {
      id: 'bread',
      imageUrl: null,
      imageTextLocale: null,
      localizedImages: { en: '/bread-en.webp' },
      imageUrlEn: '/bread-old.webp',
    },
  ];

  function reader() {
    const findMany = vi.fn(async (_args: unknown) => rows);
    return { findMany, tx: { product: { findMany } } as unknown as Prisma.TransactionClient };
  }

  it('reads picture fields and the legacy column in one statement and returns canonical dictionaries', async () => {
    const { findMany, tx } = reader();
    const where = { id: { in: ['milk', 'bread'] }, isGlobal: true };

    const pictures = await readVisibleSnapshotPictures(tx, where);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where,
      select: { imageUrlEn: true, localizedImages: true, imageUrl: true },
    });
    expect(pictures.get('milk')).toEqual({
      imageUrl: '/milk.webp',
      imageTextLocale: 'ru',
      localizedImages: { en: '/milk-en.webp' },
    });
    expect(pictures.get('bread')?.localizedImages).toEqual({ en: '/bread-en.webp' });
    // The legacy value never leaves the helper as a field of its own.
    expect(JSON.stringify([...pictures.values()])).not.toMatch(/imageUrlEn|bread-old/);
  });

  it('fails loudly when the read fails', async () => {
    const tx = {
      product: {
        findMany: async () => {
          throw new Error('connection reset');
        },
      },
    } as unknown as Prisma.TransactionClient;
    await expect(readVisibleSnapshotPictures(tx, {})).rejects.toThrow('connection reset');
  });
});
