// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyCell,
  findBatchFiles,
  normalizeCatalogName,
  planProduct,
  sliceSheet,
  type CellPlan,
  type ManifestCell,
} from './emoji-batch-import';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEFIR: ManifestCell = {
  cell: 3,
  category: 'Молочные продукты',
  name: 'Кефир',
  nameEn: 'Kefir',
  action: 'create',
};

describe('findBatchFiles', () => {
  it('finds the sheet, its English version and single re-generated cells', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emoji-batches-'));
    dirs.push(dir);
    for (const name of [
      'batch-005.png',
      'batch-005-en.jpg',
      'batch-005-3.png',
      'batch-005-3-en.webp',
      'batch-0050.png',
      'batch-006.png',
      'notes.txt',
    ]) {
      writeFileSync(join(dir, name), '');
    }

    const files = findBatchFiles(dir, 'batch-005');

    expect(files.sheet).toBe(join(dir, 'batch-005.png'));
    expect(files.sheetEn).toBe(join(dir, 'batch-005-en.jpg'));
    expect(files.cells.get(3)).toEqual({
      ru: join(dir, 'batch-005-3.png'),
      en: join(dir, 'batch-005-3-en.webp'),
    });
    expect(files.cells.size).toBe(1);
  });
});

describe('sliceSheet', () => {
  it('cuts three columns left to right, top to bottom', async () => {
    const colours = ['#f00', '#0f0', '#00f', '#ff0', '#0ff', '#f0f', '#000', '#888', '#fff'];
    const rects = colours
      .map(
        (fill, i) =>
          `<rect x="${(i % 3) * 30}" y="${Math.floor(i / 3) * 30}" width="30" height="30" fill="${fill}"/>`
      )
      .join('');
    const sheet = await sharp(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90">${rects}</svg>`)
    )
      .png()
      .toBuffer();

    const cells = await sliceSheet(sheet, 9);

    const centre = async (cell: Buffer) => {
      const { data } = await sharp(cell).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const i = (15 * 30 + 15) * 3;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect(cells).toHaveLength(9);
    expect(await centre(cells[1])).toEqual([0, 255, 0]);
    expect(await centre(cells[5])).toEqual([255, 0, 255]);
  });
});

describe('planProduct', () => {
  const index = {
    products: new Map([
      [normalizeCatalogName('Сгущённое молоко'), { id: 'p1', name: 'Сгущенное молоко' }],
    ]),
    categories: new Map([[normalizeCatalogName('Молочные продукты'), { id: 'c1', emoji: '🥛' }]]),
  };

  it('links an existing product by name, ё and case aside', () => {
    expect(planProduct({ ...KEFIR, name: 'сгущенное  молоко' }, index)).toEqual({
      kind: 'link',
      productId: 'p1',
      productName: 'Сгущенное молоко',
    });
  });

  it('creates a missing product in its category', () => {
    expect(planProduct(KEFIR, index)).toEqual({
      kind: 'create',
      categoryId: 'c1',
      categoryEmoji: '🥛',
    });
  });

  it('keeps the picture in the library only when the category is unknown', () => {
    expect(planProduct({ ...KEFIR, category: 'Нет такой' }, index)).toEqual({
      kind: 'no-category',
    });
  });

  it('does not link a cell whose picture is redrawn in a text batch', () => {
    expect(planProduct({ ...KEFIR, supersededBy: 'text-001#2' }, index)).toEqual({
      kind: 'superseded',
      by: 'text-001#2',
    });
  });
});

describe('applyCell', () => {
  function fakePrisma() {
    return {
      emojiLibraryItem: { upsert: vi.fn().mockResolvedValue({}) },
      product: { update: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
    };
  }

  const plan = (overrides: Partial<CellPlan> = {}): CellPlan => ({
    ref: 'batch-005#3',
    batch: 'batch-005',
    batchKind: 'text',
    cell: KEFIR,
    images: { ru: Buffer.from('ru'), en: Buffer.from('en') },
    stored: {},
    product: { kind: 'create', categoryId: 'c1', categoryEmoji: '🥛' },
    ...overrides,
  });

  it('uploads both languages, records them as one group and creates the product', async () => {
    const prisma = fakePrisma();
    const upload = vi.fn(async (_image: Buffer, name: string) =>
      name === 'Kefir' ? 'https://utfs.io/f/en.webp' : 'https://utfs.io/f/ru.webp'
    );

    const result = await applyCell(prisma as unknown as PrismaClient, plan(), upload);

    expect(result).toMatchObject({ uploaded: 2, product: 'created' });
    expect(prisma.emojiLibraryItem.upsert.mock.calls.map(([args]) => args.create)).toEqual([
      expect.objectContaining({ sourceRef: 'batch-005#3', locale: 'ru', groupKey: 'batch-005#3' }),
      expect.objectContaining({
        sourceRef: 'batch-005#3:en',
        locale: 'en',
        groupKey: 'batch-005#3',
      }),
    ]);
    expect(prisma.product.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Кефир',
        emoji: '🥛',
        isGlobal: true,
        isCustom: true,
        imageUrl: 'https://utfs.io/f/ru.webp',
        imageUrlEn: 'https://utfs.io/f/en.webp',
      }),
    });
  });

  it('records a text-free batch picture for every language and clears a stale English one', async () => {
    const prisma = fakePrisma();
    const upload = vi.fn(async () => 'https://utfs.io/f/x.webp');

    await applyCell(
      prisma as unknown as PrismaClient,
      plan({ batchKind: 'universal', images: { ru: Buffer.from('ru'), en: Buffer.from('en') } }),
      upload
    );

    expect(upload).toHaveBeenCalledTimes(1);
    expect(prisma.emojiLibraryItem.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.emojiLibraryItem.upsert.mock.calls[0][0].create.locale).toBeNull();
    expect(prisma.product.create.mock.calls[0][0].data.imageUrlEn).toBeNull();
  });

  it('keeps a stored English picture when only the Russian label sheet is imported', async () => {
    const prisma = fakePrisma();
    const upload = vi.fn(async () => 'https://utfs.io/f/ru.webp');

    await applyCell(
      prisma as unknown as PrismaClient,
      plan({
        images: { ru: Buffer.from('ru') },
        product: { kind: 'link', productId: 'p1', productName: 'Кефир' },
      }),
      upload
    );

    expect(prisma.emojiLibraryItem.upsert.mock.calls[0][0].create.locale).toBe('ru');
    expect(prisma.product.update.mock.calls[0][0].data).toEqual({
      isCustom: true,
      imageUrl: 'https://utfs.io/f/ru.webp',
    });
  });

  it('keeps a cell redrawn in a text batch in the library only', async () => {
    const prisma = fakePrisma();
    const upload = vi.fn(async () => 'https://utfs.io/f/old.webp');

    const result = await applyCell(
      prisma as unknown as PrismaClient,
      plan({
        batchKind: 'universal',
        images: { ru: Buffer.from('ru') },
        product: { kind: 'superseded', by: 'text-001#2' },
      }),
      upload
    );

    expect(result.product).toBe('superseded');
    expect(prisma.emojiLibraryItem.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('reuses stored pictures on a re-run and only re-links the product', async () => {
    const prisma = fakePrisma();
    const upload = vi.fn();

    const result = await applyCell(
      prisma as unknown as PrismaClient,
      plan({
        stored: { ru: 'https://utfs.io/f/ru.webp', en: 'https://utfs.io/f/en.webp' },
        product: { kind: 'link', productId: 'p1', productName: 'Кефир' },
      }),
      upload
    );

    expect(upload).not.toHaveBeenCalled();
    expect(result).toMatchObject({ uploaded: 0, product: 'linked' });
    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: {
        isCustom: true,
        imageUrl: 'https://utfs.io/f/ru.webp',
        imageUrlEn: 'https://utfs.io/f/en.webp',
      },
    });
  });
});
