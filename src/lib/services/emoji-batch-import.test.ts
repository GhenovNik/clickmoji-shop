// @vitest-environment node
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readBatchImages,
  applyCell,
  findBatchFiles,
  libraryTags,
  normalizeCatalogName,
  parseReplacementAuthorization,
  planProduct,
  sliceSheet,
  type CellPlan,
  type ManifestBatch,
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

describe('readBatchImages gap clearing', { timeout: 30_000 }, () => {
  // A green ring around a pure white centre, the left third of a 3-column sheet.
  async function ringSheet() {
    return sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="100%" height="100%" fill="#fff"/><circle cx="50" cy="50" r="40" fill="#43a047"/><circle cx="50" cy="50" r="15" fill="#fff"/></svg>'
      )
    )
      .png()
      .toBuffer();
  }

  async function centreAlpha(cell: Partial<ManifestCell>, kind: 'universal' | 'text') {
    const sheet = await ringSheet();
    const images = await readBatchImages(
      { batch: 'batch-099', kind, file: 'x.png', cells: [{ ...KEFIR, cell: 1, ...cell }] },
      { sheet: 'sheet', cells: new Map() },
      () => sheet
    );
    const { data, info } = await sharp(images.get(1)!.ru)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data[(128 * info.width + 128) * 4 + 3];
  }

  it('clears an enclosed gap only for a cell whose gaps were checked', async () => {
    expect(await centreAlpha({ gaps: true }, 'universal')).toBe(0);
    expect(await centreAlpha({}, 'universal')).toBe(255);
  });

  it('never clears gaps on a labelled product, even in a text-free batch', async () => {
    expect(await centreAlpha({ gaps: true, text: true }, 'universal')).toBe(255);
    expect(await centreAlpha({ gaps: true }, 'text')).toBe(255);
  });
});

describe('sliceSheet', () => {
  it('takes a short batch from the top row of a square sheet and ignores extra rows', async () => {
    // Three icons on top and an extra row at the bottom, as in a downloaded file that carried a row
    // of another batch although Gemini itself showed only the three icons.
    const sheet = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><rect width="100%" height="100%" fill="#fff"/><rect x="0" y="0" width="30" height="30" fill="#f00"/><rect x="30" y="0" width="30" height="30" fill="#0f0"/><rect x="60" y="0" width="30" height="30" fill="#00f"/><rect x="0" y="60" width="90" height="30" fill="#000"/></svg>'
      )
    )
      .png()
      .toBuffer();

    const cells = await sliceSheet(sheet, 3);

    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      const { height } = await sharp(cell).metadata();
      expect(height).toBe(30);
    }
  });

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
  const dairy = { id: 'c1', name: 'Молочные продукты', emoji: '🥛' };
  const index = {
    products: new Map([
      [
        normalizeCatalogName('Сгущённое молоко'),
        [{ id: 'p1', name: 'Сгущенное молоко', categoryId: 'c1', categoryName: dairy.name }],
      ],
      [
        normalizeCatalogName('Чай'),
        [
          { id: 'a', name: 'Чай', categoryId: 'c1', categoryName: dairy.name },
          { id: 'b', name: ' чай ', categoryId: 'c1', categoryName: dairy.name },
        ],
      ],
    ]),
    variants: new Map(),
    categories: new Map([[normalizeCatalogName('Молочные продукты'), dairy]]),
    categoriesByKey: new Map([[normalizeCatalogName('Молочные продукты'), [dairy]]]),
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

  it('links nothing when several catalogue products share the name', () => {
    expect(planProduct({ ...KEFIR, name: 'Чай' }, index)).toEqual({
      kind: 'ambiguous',
      productNames: ['Чай', ' чай '],
    });
  });

  it('does not link a cell whose picture is redrawn in a text batch', () => {
    expect(planProduct({ ...KEFIR, supersededBy: 'text-001#2' }, index)).toEqual({
      kind: 'superseded',
      by: 'text-001#2',
    });
  });
});

describe('planProduct for queue targets', () => {
  const apple = { id: 'apple', name: 'Яблоко', categoryId: 'c2', categoryName: 'Фрукты' };
  const index = {
    products: new Map([
      [normalizeCatalogName('Яблоко'), [apple]],
      [
        normalizeCatalogName('Хлеб'),
        [{ id: 'bread', name: 'Хлеб', categoryId: 'c4', categoryName: 'Выпечка' }],
      ],
      [
        normalizeCatalogName('Дубль'),
        [
          { id: 'd1', name: 'Дубль', categoryId: 'c2', categoryName: 'Фрукты' },
          { id: 'd2', name: 'Дубль', categoryId: 'c2', categoryName: 'Фрукты' },
        ],
      ],
      [
        normalizeCatalogName('Тыква'),
        [{ id: 'pumpkin', name: 'Тыква', categoryId: 'c3', categoryName: 'Овощи' }],
      ],
    ]),
    variants: new Map([
      [
        'apple',
        [
          { id: 'v1', name: 'Яблоко Ханикрисп' },
          { id: 'v2', name: 'Яблоко Гала' },
        ],
      ],
      [
        'bread',
        [
          { id: 'v3', name: 'Хлеб белый' },
          { id: 'v4', name: 'Хлеб белый' },
        ],
      ],
    ]),
    categories: new Map([
      [normalizeCatalogName('Фрукты'), { id: 'c2', name: 'Фрукты', emoji: '🍎' }],
      [normalizeCatalogName('Овощи'), { id: 'c3', name: 'Овощи', emoji: '🥕' }],
      [normalizeCatalogName('Выпечка'), { id: 'c4', name: 'Выпечка', emoji: '🍞' }],
    ]),
    categoriesByKey: new Map([
      [normalizeCatalogName('Фрукты'), [{ id: 'c2', name: 'Фрукты', emoji: '🍎' }]],
      [normalizeCatalogName('Овощи'), [{ id: 'c3', name: 'Овощи', emoji: '🥕' }]],
      [normalizeCatalogName('Выпечка'), [{ id: 'c4', name: 'Выпечка', emoji: '🍞' }]],
    ]),
  };
  const target = (overrides: Partial<ManifestCell>): ManifestCell => ({
    cell: 1,
    category: 'Фрукты',
    name: 'Яблоко',
    nameEn: 'Apple',
    action: 'update-image',
    target: 'product',
    ...overrides,
  });

  it('finds a variant under its parent product', () => {
    expect(
      planProduct(
        target({ target: 'variant', parent: 'яблоко', name: 'Яблоко  Ханикрисп', nameEn: 'x' }),
        index
      )
    ).toEqual({
      kind: 'variant',
      variantId: 'v1',
      productName: 'Яблоко',
      variantName: 'Яблоко Ханикрисп',
    });
  });

  it('does not take a variant of another product with the same name', () => {
    expect(
      planProduct(target({ target: 'variant', parent: 'Яблоко', name: 'Хлеб белый' }), index)
    ).toEqual({ kind: 'not-found', reason: 'нет варианта «Хлеб белый» у товара «Яблоко»' });
  });

  it('reports an unknown parent and an unknown variant as not found', () => {
    expect(planProduct(target({ target: 'variant', parent: 'Нет', name: 'x' }), index)).toEqual({
      kind: 'not-found',
      reason: 'нет товара «Нет»',
    });
  });

  it('lists the products when a variant parent name is ambiguous', () => {
    const dup = {
      ...index,
      products: new Map([
        [normalizeCatalogName('Дубль'), index.products.get(normalizeCatalogName('Дубль'))!],
      ]),
    };
    expect(planProduct(target({ target: 'variant', parent: 'Дубль', name: 'x' }), dup)).toEqual({
      kind: 'ambiguous',
      productNames: ['Дубль', 'Дубль'],
    });
  });

  it('lists the variants when one parent has two variants of that name', () => {
    expect(
      planProduct(
        target({ target: 'variant', parent: 'Хлеб', name: 'Хлеб белый', category: 'Выпечка' }),
        index
      )
    ).toEqual({
      kind: 'ambiguous-variant',
      productName: 'Хлеб',
      variantNames: ['Хлеб белый', 'Хлеб белый'],
    });
  });

  it('finds a category by its own name and reports a missing one', () => {
    expect(planProduct(target({ target: 'category', name: 'фрукты' }), index)).toEqual({
      kind: 'category',
      categoryId: 'c2',
      categoryName: 'Фрукты',
    });
    expect(planProduct(target({ target: 'category', name: 'Мясо' }), index)).toEqual({
      kind: 'not-found',
      reason: 'нет категории «Мясо»',
    });
  });

  it('never creates a queue product that is missing from the catalogue', () => {
    expect(planProduct(target({ name: 'Манго' }), index)).toEqual({
      kind: 'not-found',
      reason: 'нет товара «Манго»',
    });
  });

  it('keeps the historical create fallback for cells without a target', () => {
    const { target: _target, ...legacy } = target({ name: 'Манго' });
    expect(planProduct({ ...legacy, action: 'create' }, index)).toEqual({
      kind: 'create',
      categoryId: 'c2',
      categoryEmoji: '🍎',
    });
  });
});

describe('applyCell', () => {
  function fakePrisma() {
    return {
      emojiLibraryItem: {
        upsert: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      product: {
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      productVariant: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      category: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
      },
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
        localizedImages: { en: 'https://utfs.io/f/en.webp' },
        // The legacy column is written as a rollback mirror of the dictionary entry.
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

  it('keeps a fresh upload whose library record failed: nothing is deleted remotely (AGE-1667 B3)', async () => {
    const prisma = fakePrisma();
    prisma.emojiLibraryItem.upsert.mockRejectedValueOnce(new Error('db down'));
    const upload = vi.fn(async () => 'https://utfs.io/f/fresh.webp');

    await expect(applyCell(prisma as unknown as PrismaClient, plan(), upload)).rejects.toThrow(
      'db down'
    );

    expect(upload).toHaveBeenCalledTimes(1);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('never removes a picture that was already stored before this run', async () => {
    const prisma = fakePrisma();
    prisma.emojiLibraryItem.upsert.mockRejectedValueOnce(new Error('db down'));

    await expect(
      applyCell(
        prisma as unknown as PrismaClient,
        plan({ stored: { ru: 'https://utfs.io/f/old.webp' } }),
        vi.fn()
      )
    ).rejects.toThrow('db down');
  });

  it('leaves the product alone when the name is ambiguous', async () => {
    const prisma = fakePrisma();

    const result = await applyCell(
      prisma as unknown as PrismaClient,
      plan({ product: { kind: 'ambiguous', productNames: ['Чай', ' чай '] } }),
      vi.fn(async () => 'https://utfs.io/f/x.webp')
    );

    expect(result.product).toBe('ambiguous');
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.product.create).not.toHaveBeenCalled();
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
        localizedImages: { en: 'https://utfs.io/f/en.webp' },
        imageUrlEn: 'https://utfs.io/f/en.webp',
      },
    });
  });
});

describe('applyCell for variants and categories', () => {
  const PNG = Buffer.from('ru');
  const HONEYCRISP: ManifestCell = {
    cell: 1,
    category: 'Фрукты',
    name: 'Яблоко Ханикрисп',
    nameEn: 'Honeycrisp apple',
    action: 'update-image',
    target: 'variant',
    parent: 'Яблоко',
  };

  function records() {
    return {
      emojiLibraryItem: {
        upsert: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      product: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      productVariant: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      category: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
  }

  const planFor = (product: CellPlan['product'], overrides: Partial<CellPlan> = {}): CellPlan => ({
    ref: 'queue-001#1',
    batch: 'queue-001',
    batchKind: 'universal',
    cell: HONEYCRISP,
    images: { ru: PNG },
    stored: {},
    product,
    ...overrides,
  });

  it('writes the variant picture to the variant only', async () => {
    const prisma = records();
    const plan = planFor({
      kind: 'variant',
      variantId: 'v1',
      productName: 'Яблоко',
      variantName: 'Яблоко Ханикрисп',
    });

    const result = await applyCell(
      prisma as unknown as PrismaClient,
      plan,
      vi.fn(async () => 'https://utfs.io/f/variant.webp')
    );

    expect(result).toMatchObject({ product: 'variant', changed: true, uploaded: 1 });
    expect(prisma.productVariant.updateMany).toHaveBeenCalledWith({
      // Written only while the variant still has no picture: a manual one is never replaced.
      where: {
        id: 'v1',
        imageUrl: null,
        localizedImages: { equals: Prisma.DbNull },
        imageUrlEn: null,
      },
      // A text-free picture serves both languages, so a stale English one is cleared.
      data: { imageUrl: 'https://utfs.io/f/variant.webp', imageUrlEn: null },
    });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('writes the category picture with the custom flag the storefront checks', async () => {
    const prisma = records();
    const plan = planFor(
      { kind: 'category', categoryId: 'c2', categoryName: 'Фрукты' },
      { cell: { ...HONEYCRISP, name: 'Фрукты', nameEn: 'Fruits', target: 'category' } }
    );

    await applyCell(
      prisma as unknown as PrismaClient,
      plan,
      vi.fn(async () => 'https://utfs.io/f/cat.webp')
    );

    expect(prisma.category.updateMany).toHaveBeenCalledWith({
      where: { id: 'c2', imageUrl: null },
      data: { isCustom: true, imageUrl: 'https://utfs.io/f/cat.webp' },
    });
  });

  it('refuses a category picture that carries text, before anything is written', async () => {
    const prisma = records();
    const plan = planFor(
      { kind: 'category', categoryId: 'c2', categoryName: 'Фрукты' },
      { batchKind: 'text', images: { ru: PNG, en: PNG } }
    );
    const upload = vi.fn(async () => 'https://utfs.io/f/x.webp');

    await expect(applyCell(prisma as unknown as PrismaClient, plan, upload)).rejects.toThrow(
      'text-free'
    );
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.emojiLibraryItem.upsert).not.toHaveBeenCalled();
  });

  it('keeps a not-found target in the library and writes no catalogue record', async () => {
    const prisma = records();
    const plan = planFor({ kind: 'not-found', reason: 'нет варианта «Яблоко Ханикрисп»' });

    const result = await applyCell(
      prisma as unknown as PrismaClient,
      plan,
      vi.fn(async () => 'https://utfs.io/f/x.webp')
    );

    expect(result).toMatchObject({ product: 'not-found', changed: true });
    expect(prisma.emojiLibraryItem.create).toHaveBeenCalledTimes(1);
    expect(prisma.productVariant.update).not.toHaveBeenCalled();
    expect(prisma.category.update).not.toHaveBeenCalled();
  });

  it('writes nothing on a re-run when every record already holds the picture', async () => {
    const prisma = records();
    const stored = 'https://utfs.io/f/cat.webp';
    prisma.emojiLibraryItem.findUnique.mockResolvedValue({
      imageUrl: stored,
      name: 'Яблоко Ханикрисп',
      nameEn: 'Honeycrisp apple',
      tags: ['фрукты', 'queue:variant', 'parent:яблоко'],
      source: 'batch',
      locale: null,
      groupKey: 'queue-001#1',
    });
    prisma.productVariant.findUnique.mockResolvedValue({ imageUrl: stored, localizedImages: null });
    const plan = planFor(
      { kind: 'variant', variantId: 'v1', productName: 'Яблоко', variantName: 'Яблоко Ханикрисп' },
      { stored: { ru: stored } }
    );
    const upload = vi.fn();

    const result = await applyCell(prisma as unknown as PrismaClient, plan, upload);

    expect(result).toMatchObject({ product: 'variant', changed: false, uploaded: 0 });
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.emojiLibraryItem.upsert).not.toHaveBeenCalled();
    expect(prisma.productVariant.update).not.toHaveBeenCalled();
  });
});

const KEY = normalizeCatalogName;
const FRUIT = { id: 'c2', name: 'Фрукты', emoji: '🍎' };
const VEG = { id: 'c3', name: 'Овощи', emoji: '🥕' };

describe('queue targets are matched by category and parent (AGE-1667 B1)', () => {
  const index = {
    products: new Map([
      [KEY('Тыква'), [{ id: 'pumpkin', name: 'Тыква', categoryId: 'c3', categoryName: 'Овощи' }]],
      [KEY('Яблоко'), [{ id: 'apple', name: 'Яблоко', categoryId: 'c2', categoryName: 'Фрукты' }]],
      [
        KEY('Сок'),
        [
          { id: 'sok-fruit', name: 'Сок', categoryId: 'c2', categoryName: 'Фрукты' },
          { id: 'sok-veg', name: 'Сок', categoryId: 'c3', categoryName: 'Овощи' },
        ],
      ],
    ]),
    variants: new Map(),
    categories: new Map([
      [KEY('Фрукты'), FRUIT],
      [KEY('Овощи'), VEG],
    ]),
    categoriesByKey: new Map([
      [KEY('Фрукты'), [FRUIT]],
      [KEY('Овощи'), [VEG]],
    ]),
  };
  const cell = (overrides: Partial<ManifestCell>): ManifestCell => ({
    cell: 1,
    category: 'Фрукты',
    name: 'Тыква',
    nameEn: 'Pumpkin',
    action: 'update-image',
    target: 'product',
    ...overrides,
  });

  it('does not take a sole product of the same name from another category', () => {
    expect(planProduct(cell({ name: 'Тыква', category: 'Фрукты' }), index)).toEqual({
      kind: 'not-found',
      reason: 'нет товара «Тыква» в категории «Фрукты» (есть в «Овощи»)',
    });
  });

  it('does not take a variant whose parent sits in another category', () => {
    expect(
      planProduct(
        cell({ target: 'variant', parent: 'Тыква', name: 'Тыква белая', category: 'Фрукты' }),
        index
      )
    ).toEqual({
      kind: 'not-found',
      reason: 'нет товара «Тыква» в категории «Фрукты» (есть в «Овощи»)',
    });
  });

  it('links the product of the named category when the name is shared', () => {
    expect(planProduct(cell({ name: 'Сок', category: 'Овощи' }), index)).toEqual({
      kind: 'link',
      productId: 'sok-veg',
      productName: 'Сок',
    });
    expect(planProduct(cell({ name: 'Сок', category: 'Фрукты' }), index)).toEqual({
      kind: 'link',
      productId: 'sok-fruit',
      productName: 'Сок',
    });
  });

  it('is ambiguous, naming both categories, when normalized category names collide', () => {
    const colliding = {
      ...index,
      categoriesByKey: new Map([
        [KEY('Фрукты'), [FRUIT, { id: 'c9', name: 'фрукты ', emoji: '🍐' }]],
      ]),
    };
    expect(planProduct(cell({ name: 'Яблоко', category: 'Фрукты' }), colliding)).toEqual({
      kind: 'ambiguous-category',
      categoryNames: ['Фрукты', 'фрукты '],
    });
  });

  it('is ambiguous for a category target when normalized category names collide', () => {
    const colliding = {
      ...index,
      categoriesByKey: new Map([
        [KEY('Фрукты'), [FRUIT, { id: 'c9', name: 'фрукты ', emoji: '🍐' }]],
      ]),
    };
    expect(
      planProduct(cell({ target: 'category', name: 'Фрукты', category: 'Фрукты' }), colliding)
    ).toEqual({ kind: 'ambiguous-category', categoryNames: ['Фрукты', 'фрукты '] });
  });
});

type Row = { id: string } & Record<string, unknown>;

// The catalogue tables the reference check reads; none holds a URL unless a test gives it one.
const noCatalogue = () => ({
  product: { findFirst: vi.fn(async () => null) },
  productVariant: { findFirst: vi.fn(async () => null) },
  category: { findFirst: vi.fn(async () => null) },
});

// Whether a stored value satisfies one `where` condition: a plain value must be equal, a JSON
// column is compared with `{ equals }` (SQL NULL is Prisma.DbNull), as PostgreSQL would.
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const satisfies = (value: unknown, condition: unknown) => {
  if (condition !== null && typeof condition === 'object' && 'equals' in condition) {
    const { equals } = condition as { equals: unknown };
    return equals === Prisma.DbNull ? value == null : sameJson(value, equals);
  }
  // A column a row does not carry is SQL NULL, as for the legacy English column of a test row.
  return condition === null ? (value ?? null) === null : value === condition;
};

// Whether a catalogue row matches one clause of a `where.OR` list, as the reference check asks.
const matchesClause = (row: Row, clause: Record<string, unknown>) =>
  Object.entries(clause).every(([key, value]) => satisfies(row[key], value));

// What the database stores: Prisma.DbNull is SQL NULL.
const stored = (data: Row) =>
  Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, value === Prisma.DbNull ? null : value])
  );

// A record whose conditional write checks the row as it stands when the write runs.
function liveRow<T extends Row>(row: T) {
  return {
    findUnique: vi.fn(async () => ({ ...row })),
    findFirst: vi.fn(async ({ where }: { where: { OR?: Record<string, unknown>[] } }) =>
      (where.OR ?? []).some((clause) => matchesClause(row, clause)) ? { id: row.id } : null
    ),
    update: vi.fn(async ({ data }: { data: Row }) => Object.assign(row, stored(data))),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const holds = Object.entries(where).every(([key, value]) => satisfies(row[key], value));
      if (!holds) return { count: 0 };
      Object.assign(row, stored(data));
      return { count: 1 };
    }),
  };
}

type LibraryRow = {
  id: string;
  sourceRef: string;
  imageUrl: string;
  name: string;
  nameEn: string | null;
  tags: string[];
  source: string;
  locale: string | null;
  groupKey: string | null;
};
type LibraryData = Omit<LibraryRow, 'id'>;

// Prisma's error for a unique key; `field` is the key the native error names.
function uniqueViolation(field: 'sourceRef' | 'imageUrl' = 'sourceRef') {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), {
    code: 'P2002',
  });
}

// An emoji library table with both unique keys of the schema (sourceRef and imageUrl). `afterRead`
// runs after a read has taken its snapshot and `afterCreate` after an insert, so a test can order
// two runs.
function memoryLibrary(
  seed: LibraryData[] = [],
  hooks: { afterRead?: () => Promise<void>; afterCreate?: (data: LibraryData) => void } = {}
) {
  const rows = new Map<string, LibraryRow>();
  let next = 1;
  const copy = (row: LibraryRow | undefined) => (row ? { ...row, tags: [...row.tags] } : null);
  for (const data of seed) rows.set(data.sourceRef, { ...data, id: `lib${next++}` });
  const byUrl = (url: string) => [...rows.values()].find((row) => row.imageUrl === url);
  return {
    rows,
    findUnique: vi.fn(async ({ where }: { where: { sourceRef?: string; imageUrl?: string } }) => {
      const row = copy(
        where.sourceRef !== undefined ? rows.get(where.sourceRef) : byUrl(where.imageUrl ?? '')
      );
      await hooks.afterRead?.();
      return row;
    }),
    create: vi.fn(async ({ data }: { data: LibraryData }) => {
      if (rows.has(data.sourceRef)) throw uniqueViolation('sourceRef');
      if (byUrl(data.imageUrl)) throw uniqueViolation('imageUrl');
      const row = { ...data, id: `lib${next++}` };
      rows.set(data.sourceRef, row);
      hooks.afterCreate?.(data);
      return copy(row);
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; name: string; tags: { equals: string[] } };
        data: Partial<LibraryData>;
      }) => {
        const row = [...rows.values()].find((r) => r.id === where.id);
        if (!row || row.name !== where.name || row.tags.join('|') !== where.tags.equals.join('|')) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { sourceRef: string };
        create: LibraryData;
        update: Partial<LibraryData>;
      }) => {
        const row = rows.get(where.sourceRef);
        if (row) {
          Object.assign(row, update);
          return copy(row);
        }
        const inserted = { ...create, id: `lib${next++}` };
        rows.set(create.sourceRef, inserted);
        hooks.afterCreate?.(create);
        return copy(inserted);
      }
    ),
  };
}

describe('queue writes are conditional on the state at write time (AGE-1667 B2)', () => {
  const PNG = Buffer.from('ru');
  const QUEUED = 'https://utfs.io/f/queued.webp';
  const MANUAL = 'https://utfs.io/f/manual.webp';

  const libraryNone = () => ({
    upsert: vi.fn().mockResolvedValue({}),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
  });
  const queueCell = (overrides: Partial<ManifestCell> = {}): ManifestCell => ({
    cell: 1,
    target: 'product',
    category: 'Молочные продукты',
    name: 'Кефир',
    nameEn: 'Kefir',
    action: 'update-image',
    ...overrides,
  });
  const queuePlan = (product: CellPlan['product'], overrides: Partial<CellPlan> = {}) =>
    ({
      ref: 'queue-001#1',
      batch: 'queue-001',
      batchKind: 'universal',
      cell: queueCell(),
      images: { ru: PNG },
      stored: {},
      product,
      ...overrides,
    }) as CellPlan;

  it('does not overwrite a picture attached by hand between the preview and the apply', async () => {
    const product: {
      id: string;
      imageUrl: string | null;
      localizedImages: Record<string, string> | null;
      isCustom: boolean;
    } = { id: 'p1', imageUrl: null, localizedImages: null, isCustom: false };
    const row = liveRow(product);
    // The picture is attached by hand after this run has read the product.
    row.findUnique.mockImplementationOnce(async () => {
      const seen = { ...product };
      product.imageUrl = MANUAL;
      return seen;
    });
    const prisma = { emojiLibraryItem: libraryNone(), product: row };

    const result = await applyCell(
      prisma as unknown as PrismaClient,
      queuePlan({ kind: 'link', productId: 'p1', productName: 'Кефир' }),
      vi.fn(async () => QUEUED)
    );

    expect(result).toMatchObject({ product: 'conflict', changed: true });
    expect(row.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'p1',
        imageUrl: null,
        localizedImages: { equals: Prisma.DbNull },
        imageUrlEn: null,
      },
      data: { isCustom: true, imageUrl: QUEUED, imageUrlEn: null },
    });
    expect(row.update).not.toHaveBeenCalled();
    expect(product.imageUrl).toBe(MANUAL);
  });

  it('keeps an English picture set by hand when a text-free picture is queued', async () => {
    const variant = {
      id: 'v1',
      imageUrl: null,
      localizedImages: { en: 'https://utfs.io/f/manual-en.webp' },
    };
    const row = liveRow(variant);
    const prisma = { emojiLibraryItem: libraryNone(), productVariant: row };

    const result = await applyCell(
      prisma as unknown as PrismaClient,
      queuePlan(
        { kind: 'variant', variantId: 'v1', productName: 'Яблоко', variantName: 'Яблоко Гала' },
        {
          cell: queueCell({
            target: 'variant',
            parent: 'Яблоко',
            name: 'Яблоко Гала',
            category: 'Фрукты',
          }),
        }
      ),
      vi.fn(async () => QUEUED)
    );

    expect(result).toMatchObject({ product: 'conflict' });
    expect(variant.localizedImages).toEqual({ en: 'https://utfs.io/f/manual-en.webp' });
    expect(row.updateMany).not.toHaveBeenCalled();
    expect(row.update).not.toHaveBeenCalled();
  });

  it('reports a conflict and writes nothing on a re-run after a manual replacement', async () => {
    const product = { id: 'p1', imageUrl: MANUAL, localizedImages: null, isCustom: true };
    const row = liveRow(product);
    const library = libraryNone();
    library.findUnique.mockResolvedValue({
      id: 'lib1',
      imageUrl: QUEUED,
      name: 'Кефир',
      nameEn: 'Kefir',
      tags: ['молочные продукты', 'queue:product'],
      source: 'batch',
      locale: null,
      groupKey: 'queue-001#1',
    });
    const upload = vi.fn();

    const result = await applyCell(
      { emojiLibraryItem: library, product: row } as unknown as PrismaClient,
      queuePlan(
        { kind: 'link', productId: 'p1', productName: 'Кефир' },
        { stored: { ru: QUEUED } }
      ),
      upload
    );

    expect(result).toMatchObject({ product: 'conflict', uploaded: 0 });
    expect(upload).not.toHaveBeenCalled();
    expect(row.updateMany).not.toHaveBeenCalled();
    expect(row.update).not.toHaveBeenCalled();
    expect(product.imageUrl).toBe(MANUAL);
  });

  it('leaves a product that already holds the queued picture unchanged on a re-run', async () => {
    const product = { id: 'p1', imageUrl: QUEUED, localizedImages: null, isCustom: true };
    const row = liveRow(product);
    const library = libraryNone();
    library.findUnique.mockResolvedValue({
      id: 'lib1',
      imageUrl: QUEUED,
      name: 'Кефир',
      nameEn: 'Kefir',
      tags: ['молочные продукты', 'queue:product'],
      source: 'batch',
      locale: null,
      groupKey: 'queue-001#1',
    });

    const result = await applyCell(
      { emojiLibraryItem: library, product: row } as unknown as PrismaClient,
      queuePlan(
        { kind: 'link', productId: 'p1', productName: 'Кефир' },
        { stored: { ru: QUEUED } }
      ),
      vi.fn()
    );

    expect(result).toMatchObject({ product: 'linked', changed: false, uploaded: 0 });
    expect(row.updateMany).not.toHaveBeenCalled();
    expect(row.update).not.toHaveBeenCalled();
  });

  it('keeps the historical overwrite of an existing picture for cells without a target', async () => {
    const product = { id: 'p1', imageUrl: MANUAL, localizedImages: null, isCustom: true };
    const row = liveRow(product);
    const prisma = { emojiLibraryItem: libraryNone(), product: row };

    const result = await applyCell(
      prisma as unknown as PrismaClient,
      { ...queuePlan({ kind: 'link', productId: 'p1', productName: 'Кефир' }), cell: KEFIR },
      vi.fn(async () => QUEUED)
    );

    expect(result).toMatchObject({ product: 'linked', changed: true });
    expect(row.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { isCustom: true, imageUrl: QUEUED, imageUrlEn: null },
    });
    expect(row.updateMany).not.toHaveBeenCalled();
    expect(product.imageUrl).toBe(QUEUED);
  });

  it('writes nothing to the catalogue for an ambiguous category', async () => {
    const product = liveRow({ id: 'p1', imageUrl: null, localizedImages: null });
    const prisma = { emojiLibraryItem: libraryNone(), product };

    const result = await applyCell(
      prisma as unknown as PrismaClient,
      queuePlan({ kind: 'ambiguous-category', categoryNames: ['Фрукты', 'фрукты '] }),
      vi.fn(async () => QUEUED)
    );

    expect(result).toMatchObject({ product: 'ambiguous' });
    expect(product.updateMany).not.toHaveBeenCalled();
    expect(product.update).not.toHaveBeenCalled();
  });

  // A Russian sheet first, the English sheet of the same queue later (AGE-1667 B2, round 3). Only an
  // empty English slot is filled, and only while the Russian picture is the one this cell stored.
  describe.each([
    {
      label: 'product',
      key: 'product',
      start: { id: 'p1', imageUrl: null, localizedImages: null, isCustom: false } as Row,
      cell: queueCell(),
      plan: { kind: 'link', productId: 'p1', productName: 'Кефир' } as CellPlan['product'],
      kind: 'linked',
    },
    {
      label: 'variant',
      key: 'productVariant',
      start: { id: 'v1', imageUrl: null, localizedImages: null } as Row,
      cell: queueCell({
        target: 'variant',
        parent: 'Молоко',
        name: 'Кефир 2,5%',
        nameEn: 'Kefir 2.5%',
      }),
      plan: {
        kind: 'variant',
        variantId: 'v1',
        productName: 'Молоко',
        variantName: 'Кефир 2,5%',
      } as CellPlan['product'],
      kind: 'variant',
    },
  ])('a Russian picture queued before its English one: $label', (path) => {
    const RU = 'https://utfs.io/f/staged-ru.webp';
    const EN = 'https://utfs.io/f/staged-en.webp';
    const MANUAL_RU = 'https://utfs.io/f/manual-ru.webp';
    const MANUAL_EN = 'https://utfs.io/f/manual-en.webp';

    const run = (withEn: boolean) =>
      queuePlan(path.plan, {
        batchKind: 'text',
        cell: path.cell,
        images: withEn
          ? { ru: Buffer.from('ru'), en: Buffer.from('en') }
          : { ru: Buffer.from('ru') },
      });
    const catalogRow = () => {
      const data: Row = { ...path.start };
      return { data, row: liveRow(data) };
    };
    const prismaWith = (library: unknown, row: unknown) =>
      ({ emojiLibraryItem: library, [path.key]: row }) as unknown as PrismaClient;

    it('fills in the English picture and leaves the Russian one as it is', async () => {
      const library = memoryLibrary();
      const { data, row } = catalogRow();
      const prisma = prismaWith(library, row);
      const upload = vi.fn(async (image: Buffer) => (image.toString() === 'en' ? EN : RU));

      const first = await applyCell(prisma, run(false), upload);
      expect(first).toMatchObject({ product: path.kind, changed: true, uploaded: 1 });
      expect(data).toMatchObject({ imageUrl: RU, localizedImages: null });

      const second = await applyCell(prisma, run(true), upload);
      expect(second).toMatchObject({ product: path.kind, changed: true, uploaded: 1 });
      expect(second.conflict).toBeUndefined();
      expect(data).toMatchObject({ imageUrl: RU, localizedImages: { en: EN } });
      expect(row.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: path.start.id,
          imageUrl: RU,
          localizedImages: { equals: Prisma.DbNull },
          imageUrlEn: null,
        },
        data: expect.objectContaining({ imageUrl: RU, localizedImages: { en: EN } }),
      });
      expect(library.rows.get('queue-001#1')).toMatchObject({ imageUrl: RU, locale: 'ru' });
      expect(library.rows.get('queue-001#1:en')).toMatchObject({ imageUrl: EN, locale: 'en' });

      const third = await applyCell(prisma, run(true), upload);
      expect(third).toMatchObject({ product: path.kind, changed: false, uploaded: 0 });
      expect(upload).toHaveBeenCalledTimes(2);
      expect(row.updateMany).toHaveBeenCalledTimes(2);
    });

    it('reports a conflict and keeps a Russian picture replaced by hand', async () => {
      const library = memoryLibrary();
      const { data, row } = catalogRow();
      const prisma = prismaWith(library, row);
      await applyCell(
        prisma,
        run(false),
        vi.fn(async () => RU)
      );
      data.imageUrl = MANUAL_RU;

      const result = await applyCell(
        prisma,
        run(true),
        vi.fn(async (image: Buffer) => (image.toString() === 'en' ? EN : RU))
      );

      // The English library record is written before the catalogue is read; only the catalogue refuses.
      expect(result).toMatchObject({ product: 'conflict', changed: true, uploaded: 1 });
      expect(result.conflict).toBeDefined();
      expect(data).toMatchObject({ imageUrl: MANUAL_RU, localizedImages: null });
      expect(row.updateMany).toHaveBeenCalledTimes(1);
    });

    it('reports a conflict and keeps an English picture set by hand', async () => {
      const library = memoryLibrary();
      const { data, row } = catalogRow();
      const prisma = prismaWith(library, row);
      await applyCell(
        prisma,
        run(false),
        vi.fn(async () => RU)
      );
      data.localizedImages = { en: MANUAL_EN };

      const result = await applyCell(
        prisma,
        run(true),
        vi.fn(async (image: Buffer) => (image.toString() === 'en' ? EN : RU))
      );

      // The English library record is written before the catalogue is read; only the catalogue refuses.
      expect(result).toMatchObject({ product: 'conflict', changed: true, uploaded: 1 });
      expect(result.conflict).toBeDefined();
      expect(data).toMatchObject({ imageUrl: RU, localizedImages: { en: MANUAL_EN } });
      expect(row.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});

describe('library reuse is bound to the target that wrote it (AGE-1667 B3)', () => {
  const APPLE = 'https://utfs.io/f/apple.webp';
  const libraryRow = (name: string, tags: string[]) => ({
    id: 'lib1',
    imageUrl: APPLE,
    name,
    nameEn: 'Apple',
    tags,
    source: 'batch',
    locale: null,
    groupKey: 'queue-001#1',
  });
  const cellAt = (overrides: Partial<ManifestCell>): ManifestCell => ({
    cell: 1,
    target: 'product',
    category: 'Фрукты',
    name: 'Груша',
    nameEn: 'Pear',
    action: 'update-image',
    ...overrides,
  });

  it('refuses a stored picture whose record belongs to another target, with no upload or write', async () => {
    const library = {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(libraryRow('Яблоко', ['фрукты', 'queue:product'])),
    };
    const pear = { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() };
    const upload = vi.fn();

    const result = await applyCell(
      { ...noCatalogue(), emojiLibraryItem: library, product: pear } as unknown as PrismaClient,
      {
        ref: 'queue-001#1',
        batch: 'queue-001',
        batchKind: 'universal',
        cell: cellAt({}),
        images: { ru: Buffer.from('ru') },
        stored: { ru: APPLE },
        product: { kind: 'link', productId: 'pear', productName: 'Груша' },
      },
      upload
    );

    expect(result).toMatchObject({ product: 'conflict', uploaded: 0 });
    expect(upload).not.toHaveBeenCalled();
    expect(library.upsert).not.toHaveBeenCalled();
    expect(pear.updateMany).not.toHaveBeenCalled();
    expect(pear.update).not.toHaveBeenCalled();
  });

  it('refuses a stored picture of a product when the cell now names a variant', async () => {
    const library = {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(libraryRow('Яблоко', ['фрукты', 'queue:product'])),
    };
    const variant = { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() };
    const upload = vi.fn();

    const result = await applyCell(
      { emojiLibraryItem: library, productVariant: variant } as unknown as PrismaClient,
      {
        ref: 'queue-001#1',
        batch: 'queue-001',
        batchKind: 'universal',
        cell: cellAt({ name: 'Яблоко', nameEn: 'Apple', target: 'variant', parent: 'Яблоко' }),
        images: { ru: Buffer.from('ru') },
        stored: { ru: APPLE },
        product: { kind: 'variant', variantId: 'v1', productName: 'Яблоко', variantName: 'Яблоко' },
      },
      upload
    );

    expect(result).toMatchObject({ product: 'conflict', uploaded: 0 });
    expect(upload).not.toHaveBeenCalled();
    expect(variant.updateMany).not.toHaveBeenCalled();
  });

  it('reuses the stored picture of the same target without an upload', async () => {
    const product = { id: 'pear', imageUrl: null, localizedImages: null };
    const library = {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(libraryRow('Груша', ['фрукты', 'queue:product'])),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const row = {
      findUnique: vi.fn(async () => ({ ...product })),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const upload = vi.fn();

    const result = await applyCell(
      { emojiLibraryItem: library, product: row } as unknown as PrismaClient,
      {
        ref: 'queue-001#1',
        batch: 'queue-001',
        batchKind: 'universal',
        cell: cellAt({}),
        images: { ru: Buffer.from('ru') },
        stored: { ru: APPLE },
        product: { kind: 'link', productId: 'pear', productName: 'Груша' },
      },
      upload
    );

    expect(result).toMatchObject({ product: 'linked', uploaded: 0 });
    expect(upload).not.toHaveBeenCalled();
    expect(row.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'pear',
        imageUrl: null,
        localizedImages: { equals: Prisma.DbNull },
        imageUrlEn: null,
      },
      data: { isCustom: true, imageUrl: APPLE, imageUrlEn: null },
    });
  });
});

// AGE-1667 B3, round 3: the reference is bound to its owner at write. Each test orders two runs so
// that both read the reference while it is still empty, then both reach the write.
describe('a reference is bound to one owner at write (AGE-1667 B3, round 3)', () => {
  const APPLE_NEW = 'https://utfs.io/f/apple-new.webp';
  const PEAR_FIRST = 'https://utfs.io/f/pear-first.webp';
  const PEAR_SECOND = 'https://utfs.io/f/pear-second.webp';

  // A catalogue record that is still empty when read and accepts the conditional write.
  const catalogStub = () => ({
    findUnique: vi
      .fn()
      .mockResolvedValue({ imageUrl: null, localizedImages: null, isCustom: false }),
    findFirst: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  });

  const cellOf = (overrides: Partial<ManifestCell>): ManifestCell => ({
    cell: 1,
    target: 'product',
    category: 'Фрукты',
    name: 'Груша',
    nameEn: 'Pear',
    action: 'update-image',
    ...overrides,
  });
  const planOf = (cell: ManifestCell, product: CellPlan['product']): CellPlan => ({
    ref: 'queue-001#1',
    batch: 'queue-001',
    batchKind: 'universal',
    cell,
    images: { ru: Buffer.from('ru') },
    stored: {},
    product,
  });
  // Both reads wait until each run has read; the first insert opens the write of the second run.
  function racing() {
    let reads = 0;
    let bothRead!: () => void;
    const readsDone = new Promise<void>((resolve) => {
      bothRead = resolve;
    });
    let firstWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      firstWritten = resolve;
    });
    const library = memoryLibrary([], {
      afterRead: async () => {
        if (++reads === 2) bothRead();
        await readsDone;
      },
      afterCreate: () => firstWritten(),
    });
    return { library, written };
  }

  it('keeps the first owner and its picture when another target races for the same reference', async () => {
    const { library, written } = racing();
    const apple = { id: 'apple', imageUrl: null, localizedImages: null, isCustom: false } as Row;
    const appleRow = liveRow(apple);
    const pear = catalogStub();

    const [first, second] = await Promise.all([
      applyCell(
        {
          ...noCatalogue(),
          emojiLibraryItem: library,
          product: appleRow,
        } as unknown as PrismaClient,
        planOf(cellOf({ name: 'Яблоко', nameEn: 'Apple' }), {
          kind: 'link',
          productId: 'apple',
          productName: 'Яблоко',
        }),
        vi.fn(async () => APPLE_NEW)
      ),
      applyCell(
        {
          ...noCatalogue(),
          emojiLibraryItem: library,
          productVariant: pear,
        } as unknown as PrismaClient,
        planOf(cellOf({ name: 'Груша', nameEn: 'Pear', target: 'variant', parent: 'Яблоко' }), {
          kind: 'variant',
          variantId: 'v-pear',
          productName: 'Яблоко',
          variantName: 'Груша',
        }),
        vi.fn(async () => {
          await written;
          return PEAR_FIRST;
        })
      ),
    ]);

    expect(first).toMatchObject({ product: 'linked', changed: true, uploaded: 1 });
    expect(second).toMatchObject({ product: 'conflict', changed: false, uploaded: 1 });
    expect(second.conflict).toContain('записана для другой цели');
    expect(library.rows.get('queue-001#1')).toMatchObject({ imageUrl: APPLE_NEW, name: 'Яблоко' });
    expect(apple).toMatchObject({ imageUrl: APPLE_NEW });
    expect(pear.updateMany).not.toHaveBeenCalled();
    expect(pear.update).not.toHaveBeenCalled();
  });

  it('reuses the winning picture when the same cell is written by two runs at once', async () => {
    const { library, written } = racing();
    const pear = { id: 'pear', imageUrl: null, localizedImages: null, isCustom: false } as Row;
    const pearRow = liveRow(pear);
    const plan = planOf(cellOf({}), { kind: 'link', productId: 'pear', productName: 'Груша' });
    const prisma = {
      ...noCatalogue(),
      emojiLibraryItem: library,
      product: pearRow,
    } as unknown as PrismaClient;

    const [first, second] = await Promise.all([
      applyCell(
        prisma,
        plan,
        vi.fn(async () => PEAR_FIRST)
      ),
      applyCell(
        prisma,
        plan,
        vi.fn(async () => {
          await written;
          return PEAR_SECOND;
        })
      ),
    ]);

    // The second run's picture is refused by the reference and its own upload removed; the catalogue
    // only ever receives the winner's URL, whichever run reaches the catalogue first.
    for (const result of [first, second]) {
      expect(result).toMatchObject({ product: 'linked', uploaded: 1 });
      expect(result.conflict).toBeUndefined();
    }
    expect(library.create).toHaveBeenCalledTimes(2);
    expect(library.rows.get('queue-001#1')).toMatchObject({ imageUrl: PEAR_FIRST });
    expect(pear.imageUrl).toBe(PEAR_FIRST);
    expect(pearRow.updateMany.mock.calls.map(([args]) => args.data.imageUrl)).not.toContain(
      PEAR_SECOND
    );
  });

  it('keeps the fresh upload when the winner cannot be read after a collision', async () => {
    const library = memoryLibrary([
      {
        sourceRef: 'queue-001#1',
        imageUrl: APPLE_NEW,
        name: 'Яблоко',
        nameEn: 'Apple',
        tags: ['фрукты', 'queue:product'],
        source: 'batch',
        locale: null,
        groupKey: 'queue-001#1',
      },
    ]);
    library.findUnique.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('db read'));
    const pear = catalogStub();

    await expect(
      applyCell(
        { ...noCatalogue(), emojiLibraryItem: library, product: pear } as unknown as PrismaClient,
        planOf(cellOf({}), { kind: 'link', productId: 'pear', productName: 'Груша' }),
        vi.fn(async () => PEAR_FIRST)
      )
    ).rejects.toThrow('db read');

    // The winner is unknown, so the fresh upload might be the file it references: it is left.
    expect(library.rows.get('queue-001#1')).toMatchObject({ imageUrl: APPLE_NEW });
    expect(pear.updateMany).not.toHaveBeenCalled();
  });

  it('keeps its fresh upload when the insert fails for another reason (AGE-1667 B3)', async () => {
    const library = memoryLibrary();
    library.create.mockRejectedValueOnce(new Error('db write'));
    const pear = catalogStub();

    await expect(
      applyCell(
        { ...noCatalogue(), emojiLibraryItem: library, product: pear } as unknown as PrismaClient,
        planOf(cellOf({}), { kind: 'link', productId: 'pear', productName: 'Груша' }),
        vi.fn(async () => PEAR_FIRST)
      )
    ).rejects.toThrow('db write');

    expect(pear.updateMany).not.toHaveBeenCalled();
  });
});

describe('a failed read after or before an upload never orphans a file (AGE-1667 B4)', () => {
  const PNG = Buffer.from('ru');
  const cell: ManifestCell = {
    cell: 1,
    target: 'product',
    category: 'Молочные продукты',
    name: 'Кефир',
    nameEn: 'Kefir',
    action: 'update-image',
  };
  const plan = (stored: CellPlan['stored'] = {}): CellPlan => ({
    ref: 'queue-001#1',
    batch: 'queue-001',
    batchKind: 'universal',
    cell,
    images: { ru: PNG },
    stored,
    product: { kind: 'link', productId: 'p1', productName: 'Кефир' },
  });

  function fake() {
    return {
      emojiLibraryItem: {
        upsert: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      product: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ imageUrl: null, localizedImages: null, isCustom: false }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
  }

  it('reads the library record before uploading, so a failed read uploads nothing', async () => {
    const prisma = fake();
    prisma.emojiLibraryItem.findUnique.mockRejectedValueOnce(new Error('db read'));
    const upload = vi.fn(async () => 'https://utfs.io/f/fresh.webp');

    await expect(applyCell(prisma as unknown as PrismaClient, plan(), upload)).rejects.toThrow(
      'db read'
    );

    expect(upload).not.toHaveBeenCalled();
  });

  it('never deletes a stored picture when a read fails', async () => {
    const prisma = fake();
    prisma.emojiLibraryItem.findUnique.mockRejectedValueOnce(new Error('db read'));

    await expect(
      applyCell(
        prisma as unknown as PrismaClient,
        plan({ ru: 'https://utfs.io/f/old.webp' }),
        vi.fn()
      )
    ).rejects.toThrow('db read');
  });

  it('keeps a fresh upload that its library record already references when a later read fails', async () => {
    const prisma = fake();
    prisma.product.findUnique.mockRejectedValueOnce(new Error('db read'));
    const upload = vi.fn(async () => 'https://utfs.io/f/fresh.webp');

    await expect(applyCell(prisma as unknown as PrismaClient, plan(), upload)).rejects.toThrow(
      'db read'
    );

    expect(upload).toHaveBeenCalledTimes(1);
    expect(prisma.emojiLibraryItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceRef: 'queue-001#1',
        imageUrl: 'https://utfs.io/f/fresh.webp',
      }),
    });
  });
});

describe('an RU-only and an RU+EN cell of one target race (AGE-1667 B2, round 4)', () => {
  const RU_WON = 'https://utfs.io/f/ru-won.webp';
  const RU_LOST = 'https://utfs.io/f/ru-lost.webp';
  const EN = 'https://utfs.io/f/en.webp';
  const MANUAL = 'https://utfs.io/f/manual.webp';
  const MANUAL_EN = 'https://utfs.io/f/manual-en.webp';
  const REF = 'queue-001#1';

  type Kind = 'product' | 'variant';
  const cellOf = (kind: Kind): ManifestCell => ({
    cell: 1,
    target: kind,
    ...(kind === 'variant' ? { parent: 'Яблоко' } : {}),
    category: 'Фрукты',
    name: 'Груша',
    nameEn: 'Pear',
    action: 'update-image',
  });
  const planOf = (kind: Kind, withEn: boolean): CellPlan => ({
    ref: REF,
    batch: 'queue-001',
    batchKind: 'text',
    cell: cellOf(kind),
    images: withEn ? { ru: Buffer.from('ru'), en: Buffer.from('en') } : { ru: Buffer.from('ru') },
    stored: {},
    product:
      kind === 'product'
        ? { kind: 'link', productId: 'pear', productName: 'Груша' }
        : { kind: 'variant', variantId: 'v-pear', productName: 'Яблоко', variantName: 'Груша' },
  });
  // The catalogue row as it is stored; `prismaOf` gives the write path a live view of it.
  const rowOf = (kind: Kind, slots: Record<string, unknown> = {}) =>
    ({
      id: kind === 'product' ? 'pear' : 'v-pear',
      imageUrl: null,
      localizedImages: null,
      isCustom: false,
      ...slots,
    }) as Row;
  const prismaOf = (kind: Kind, library: unknown, row: Row) => {
    const record = liveRow(row);
    return {
      ...noCatalogue(),
      emojiLibraryItem: library,
      ...(kind === 'product' ? { product: record } : { productVariant: record }),
    } as unknown as PrismaClient;
  };
  // The library record this cell's own RU-only run wrote, bound to the target.
  const ownedRow = (kind: Kind, imageUrl: string, sourceRef = REF): LibraryData => ({
    sourceRef,
    imageUrl,
    name: 'Груша',
    nameEn: 'Pear',
    tags: libraryTags(cellOf(kind)),
    source: 'batch',
    locale: sourceRef === REF ? 'ru' : 'en',
    groupKey: REF,
  });

  it.each(['product', 'variant'] as const)(
    'completes the pair when the RU-only cell commits first (%s)',
    async (kind) => {
      // The RU+EN cell reads the empty reference, then waits until the RU-only cell has committed.
      let release!: () => void;
      const ruOnlyDone = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holdFirstRead = true;
      const library = memoryLibrary([], {
        afterRead: async () => {
          if (!holdFirstRead) return;
          holdFirstRead = false;
          await ruOnlyDone;
        },
      });
      const row = rowOf(kind);
      const prisma = prismaOf(kind, library, row);
      const pairUpload = vi.fn().mockResolvedValueOnce(RU_LOST).mockResolvedValueOnce(EN);

      const pair = applyCell(prisma, planOf(kind, true), pairUpload);
      const ruOnly = await applyCell(
        prisma,
        planOf(kind, false),
        vi.fn(async () => RU_WON)
      );
      release();
      const paired = await pair;

      expect(ruOnly).toMatchObject({ changed: true, conflict: undefined });
      expect(paired).toMatchObject({
        product: kind === 'product' ? 'linked' : 'variant',
        changed: true,
        conflict: undefined,
      });
      expect(row).toMatchObject({ imageUrl: RU_WON, localizedImages: { en: EN } });
      expect(library.rows.get(REF)).toMatchObject({ imageUrl: RU_WON });
      expect(library.rows.get(`${REF}:en`)).toMatchObject({ imageUrl: EN });
    }
  );

  it.each(['product', 'variant'] as const)(
    'writes nothing on a repeat of the pair once both languages are stored (%s)',
    async (kind) => {
      const library = memoryLibrary([ownedRow(kind, RU_WON), ownedRow(kind, EN, `${REF}:en`)]);
      // The state a completed first run leaves: both pictures, and the custom flag it set.
      const row = rowOf(kind, { imageUrl: RU_WON, localizedImages: { en: EN }, isCustom: true });
      const record = liveRow(row);
      const prisma = prismaOf(kind, library, row);
      const upload = vi.fn(async () => 'https://utfs.io/f/unexpected.webp');

      const again = await applyCell(prisma, planOf(kind, true), upload);

      expect(again).toMatchObject({ changed: false, uploaded: 0, conflict: undefined });
      expect(upload).not.toHaveBeenCalled();
      expect(record.updateMany).not.toHaveBeenCalled();
    }
  );

  it.each(['product', 'variant'] as const)(
    'keeps a manual Russian picture on the target and reports a conflict (%s)',
    async (kind) => {
      const library = memoryLibrary([ownedRow(kind, RU_WON)]);
      const row = rowOf(kind, { imageUrl: MANUAL });
      const prisma = prismaOf(kind, library, row);

      const pair = await applyCell(
        prisma,
        planOf(kind, true),
        vi.fn(async () => EN)
      );

      expect(pair).toMatchObject({ product: 'conflict' });
      expect(pair.conflict).toContain('уже есть картинка');
      expect(row).toMatchObject({ imageUrl: MANUAL, localizedImages: null });
    }
  );

  it.each(['product', 'variant'] as const)(
    'keeps a manual English picture on the target and reports a conflict (%s)',
    async (kind) => {
      const library = memoryLibrary([ownedRow(kind, RU_WON)]);
      const row = rowOf(kind, { imageUrl: RU_WON, localizedImages: { en: MANUAL_EN } });
      const prisma = prismaOf(kind, library, row);

      const pair = await applyCell(
        prisma,
        planOf(kind, true),
        vi.fn(async () => EN)
      );

      expect(pair).toMatchObject({ product: 'conflict' });
      expect(row).toMatchObject({ imageUrl: RU_WON, localizedImages: { en: MANUAL_EN } });
    }
  );
});

describe('a collision on either unique key never removes a file (AGE-1667 B3, rounds 4-5)', () => {
  const REF = 'queue-001#1';
  const WON = 'https://utfs.io/f/won.webp';
  const OTHER = 'https://utfs.io/f/other-ref.webp';
  const FRESH = 'https://utfs.io/f/fresh.webp';

  const pearCell: ManifestCell = {
    cell: 1,
    target: 'product',
    category: 'Фрукты',
    name: 'Груша',
    nameEn: 'Pear',
    action: 'update-image',
  };
  const planOf = (): CellPlan => ({
    ref: REF,
    batch: 'queue-001',
    batchKind: 'universal',
    cell: pearCell,
    images: { ru: Buffer.from('ru') },
    stored: {},
    product: { kind: 'link', productId: 'pear', productName: 'Груша' },
  });

  // Each read that follows the first waits for the other run to read too, so both see an empty
  // reference and race for the insert.
  function readBarrier(runs: number) {
    let reads = 0;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return async () => {
      if (++reads === runs) open();
      await opened;
    };
  }

  it('keeps the winner when both runs upload the same URL and the loser hits both keys', async () => {
    // The memory table names sourceRef first; both keys are taken by the winner's row either way.
    const library = memoryLibrary([], { afterRead: readBarrier(2) });
    const pearRow = { id: 'pear', imageUrl: null, localizedImages: null, isCustom: false };
    const prisma = {
      ...noCatalogue(),
      emojiLibraryItem: library,
      product: liveRow(pearRow),
    } as unknown as PrismaClient;

    const [first, second] = await Promise.all([
      applyCell(
        prisma,
        planOf(),
        vi.fn(async () => WON)
      ),
      applyCell(
        prisma,
        planOf(),
        vi.fn(async () => WON)
      ),
    ]);

    expect(first).toMatchObject({ product: 'linked', conflict: undefined });
    expect(second).toMatchObject({ product: 'linked', conflict: undefined });
    expect(library.rows.get(REF)).toMatchObject({ imageUrl: WON });
    expect(pearRow).toMatchObject({ imageUrl: WON });
  });

  it('keeps a fresh URL that already belongs to another reference', async () => {
    const library = memoryLibrary([
      {
        sourceRef: 'batch-009#2',
        imageUrl: FRESH,
        name: 'Яблоко',
        nameEn: 'Apple',
        tags: ['фрукты', 'queue:product'],
        source: 'batch',
        locale: null,
        groupKey: 'batch-009#2',
      },
    ]);
    const pear = liveRow({ id: 'pear', imageUrl: null, localizedImages: null, isCustom: false });
    const prisma = {
      ...noCatalogue(),
      emojiLibraryItem: library,
      product: pear,
    } as unknown as PrismaClient;

    const result = await applyCell(
      prisma,
      planOf(),
      vi.fn(async () => FRESH)
    );

    expect(result).toMatchObject({ product: 'conflict' });
    expect(library.rows.get('batch-009#2')).toMatchObject({ imageUrl: FRESH });
    expect(pear.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a fresh URL held by a catalogue record', async () => {
    const library = memoryLibrary();
    library.create.mockRejectedValueOnce(new Error('db write'));
    const pear = liveRow({ id: 'pear', imageUrl: null, localizedImages: null, isCustom: false });
    // Another catalogue record (a category, here) already holds the URL.
    const category = { findFirst: vi.fn(async () => ({ id: 'c-fruit' })) };
    const prisma = {
      ...noCatalogue(),
      emojiLibraryItem: library,
      product: pear,
      category,
    } as unknown as PrismaClient;

    await expect(
      applyCell(
        prisma,
        planOf(),
        vi.fn(async () => FRESH)
      )
    ).rejects.toThrow('db write');

    expect(pear.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a fresh URL when the reference check cannot read it', async () => {
    const library = memoryLibrary();
    library.findUnique.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('db read'));
    library.create.mockRejectedValueOnce(new Error('db write'));
    const pear = liveRow({ id: 'pear', imageUrl: null, localizedImages: null, isCustom: false });
    const prisma = {
      ...noCatalogue(),
      emojiLibraryItem: library,
      product: pear,
    } as unknown as PrismaClient;

    await expect(
      applyCell(
        prisma,
        planOf(),
        vi.fn(async () => FRESH)
      )
    ).rejects.toThrow('db write');
  });

  it('keeps both distinct fresh URLs when they race: the loser stays unreferenced, nothing is deleted', async () => {
    const library = memoryLibrary([], { afterRead: readBarrier(2) });
    const pear = liveRow({ id: 'pear', imageUrl: null, localizedImages: null, isCustom: false });
    const prisma = {
      ...noCatalogue(),
      emojiLibraryItem: library,
      product: pear,
    } as unknown as PrismaClient;
    const LOST = 'https://utfs.io/f/lost.webp';

    const [first, second] = await Promise.all([
      applyCell(
        prisma,
        planOf(),
        vi.fn(async () => WON)
      ),
      applyCell(
        prisma,
        planOf(),
        vi.fn(async () => LOST)
      ),
    ]);

    expect(first.product).toBe('linked');
    expect(second.product).toBe('linked');
    expect(second.uploaded).toBe(1);
    expect(library.rows.get(REF)).toMatchObject({ imageUrl: WON });
  });

  it('keeps a fresh URL on a historical upsert that collides on the URL of another row', async () => {
    const prisma = {
      emojiLibraryItem: {
        // The reference is free, but the URL is taken by another row.
        findUnique: vi.fn(async ({ where }: { where: { imageUrl?: string } }) =>
          where.imageUrl === FRESH ? { id: 'other', imageUrl: FRESH } : null
        ),
        upsert: vi.fn().mockRejectedValueOnce(uniqueViolation('imageUrl')),
      },
      product: {
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      productVariant: { findFirst: vi.fn().mockResolvedValue(null) },
      category: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const historical: CellPlan = {
      ref: 'batch-005#3',
      batch: 'batch-005',
      batchKind: 'universal',
      cell: KEFIR,
      images: { ru: Buffer.from('ru') },
      stored: {},
      product: { kind: 'library-only' } as unknown as CellPlan['product'],
    };

    await expect(
      applyCell(
        prisma,
        historical,
        vi.fn(async () => FRESH)
      )
    ).rejects.toThrow('imageUrl');
  });
});

describe('a failed write removes nothing, RU and EN alike (AGE-1667 B3, round 5)', () => {
  const RU = 'https://utfs.io/f/ru-history.webp';
  const EN = 'https://utfs.io/f/en-history.webp';
  const pearCell: ManifestCell = {
    cell: 1,
    target: 'product',
    category: 'Фрукты',
    name: 'Груша',
    nameEn: 'Pear',
    action: 'update-image',
  };
  // A text cell: a Russian and an English picture, each uploaded and then written as a library record.
  const textPlan = (): CellPlan => ({
    ref: 'queue-text-001#1',
    batch: 'queue-text-001',
    batchKind: 'text',
    cell: pearCell,
    images: { ru: Buffer.from('ru'), en: Buffer.from('en') },
    stored: {},
    product: { kind: 'link', productId: 'pear', productName: 'Груша' },
  });

  it('keeps the RU upload when its insert fails: a URL that only a history row may name is never removed', async () => {
    // ListHistoryItem keeps productImageUrl and productImageUrlEn readable outside the catalogue.
    // The import reads no history row and deletes no file, so the failed RU upload stays in place.
    const library = memoryLibrary();
    library.create.mockRejectedValueOnce(new Error('db write'));
    const pear = liveRow({ id: 'pear', imageUrl: null, localizedImages: null, isCustom: false });
    const upload = vi.fn(async (_image: Buffer, name: string) => (name === 'Pear' ? EN : RU));
    const prisma = {
      ...noCatalogue(),
      emojiLibraryItem: library,
      product: pear,
    } as unknown as PrismaClient;

    await expect(applyCell(prisma, textPlan(), upload)).rejects.toThrow('db write');

    expect(upload).toHaveBeenCalledTimes(1);
    expect(library.rows.size).toBe(0);
    expect(pear.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the RU record and both uploads when the EN insert fails after the RU one was written', async () => {
    const library = memoryLibrary();
    const insert = library.create.getMockImplementation()!;
    let inserts = 0;
    library.create.mockImplementation(async (args: { data: LibraryData }) => {
      if (++inserts === 2) throw new Error('db write en');
      return insert(args);
    });
    const pear = liveRow({ id: 'pear', imageUrl: null, localizedImages: null, isCustom: false });
    const upload = vi.fn(async (_image: Buffer, name: string) => (name === 'Pear' ? EN : RU));
    const prisma = {
      ...noCatalogue(),
      emojiLibraryItem: library,
      product: pear,
    } as unknown as PrismaClient;

    await expect(applyCell(prisma, textPlan(), upload)).rejects.toThrow('db write en');

    expect(upload).toHaveBeenCalledTimes(2);
    expect(library.rows.get('queue-text-001#1')).toMatchObject({ imageUrl: RU });
    expect(library.rows.get('queue-text-001#1:en')).toBeUndefined();
    expect(pear.updateMany).not.toHaveBeenCalled();
  });
});

describe('the import has no remote delete path (AGE-1667 B3, round 5)', () => {
  it('neither the service nor the import script removes an uploaded file', () => {
    for (const file of ['src/lib/services/emoji-batch-import.ts', 'scripts/emoji-import.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(/deleteFiles|discard|isUnattachedUrl/);
    }
  });
});

describe('batch prompts', () => {
  it('preserves existing batches and manifest when formatting fails', async () => {
    const { main } = await import('../../../scripts/emoji-batches');
    const dir = mkdtempSync(join(tmpdir(), 'emoji-generator-'));
    dirs.push(dir);
    for (const name of ['candidates.json', 'catalog-snapshot-2026-10-30.json']) {
      copyFileSync(join('docs/emoji-batches', name), join(dir, name));
    }
    mkdirSync(join(dir, 'batches'));
    writeFileSync(join(dir, 'batches', 'old.md'), 'old batch');
    writeFileSync(join(dir, 'manifest.json'), 'old manifest');

    await expect(
      main(dir, vi.fn().mockRejectedValue(new Error('formatter failed')))
    ).rejects.toThrow('formatter failed');
    expect(readFileSync(join(dir, 'batches', 'old.md'), 'utf8')).toBe('old batch');
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe('old manifest');
  });

  it('emits the shared style and category rule', async () => {
    const { universalPrompt, textPrompt } = await import('../../../scripts/emoji-batches');
    for (const prompt of [universalPrompt([]), textPrompt([])]) {
      expect(prompt).toContain(
        'Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.'
      );
      expect(prompt).toContain(
        'Category cells: Compose two or three items of the same group with the same lighting and simplification.'
      );
    }
  });
});

// Match explicit platform or visual-style references, not fruit names or metadata.
const forbiddenVisualReference =
  /\b(?:iphone|ios)\b|\bapple[\s-]+(?:emoji|style|styled|icons?|design|aesthetic|look)\b|\b(?:like|style of|inspired by)\s+apple\b/i;

describe('prompt visual references', () => {
  it('distinguishes brand references from product names and metadata', () => {
    for (const text of [
      'iPhone',
      'IOS',
      'Apple emoji',
      'APPLE-style',
      'like Apple',
      'Apple icons',
      'inspired by Apple',
    ]) {
      expect(forbiddenVisualReference.test(text), text).toBe(true);
    }
    for (const text of ['Apple juice', 'Pineapple', 'apple', 'apple-touch-icon', 'PWA']) {
      expect(forbiddenVisualReference.test(text), text).toBe(false);
    }
  });

  it('keeps checked-in prompts, instructions and generator free of visual brand references', () => {
    const dir = 'docs/emoji-batches/batches';
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(dir, name));
    expect(files.length).toBeGreaterThan(0);
    files.push('docs/emoji-batches/README.md', 'scripts/emoji-batches.ts');
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const matches = lines.flatMap((line, index) =>
        forbiddenVisualReference.test(line) ? [`${file}:${index + 1}: ${line}`] : []
      );
      expect(matches, matches.join('\n')).toEqual([]);
    }
  });
});

describe('replacing a category picture (AGE-1667 C6)', () => {
  const OLD = 'https://old.example.test/drinks-old.webp';
  const NEW = 'https://new.example.test/drinks-new.webp';
  const MANUAL = 'https://manual.example.test/hand-edit.webp';
  const DRINKS: ManifestCell = {
    cell: 1,
    category: 'Напитки',
    name: 'Напитки',
    nameEn: 'Beverages',
    action: 'replace',
    target: 'category',
    hint: 'exactly three most recognizable drinks together in one composition',
  };
  const planFor = (overrides: Partial<CellPlan> = {}): CellPlan => ({
    ref: 'queue-011#1',
    batch: 'queue-011',
    batchKind: 'universal',
    cell: DRINKS,
    images: { ru: Buffer.from('ru') },
    stored: {},
    product: { kind: 'category', categoryId: 'c-drinks', categoryName: 'Напитки' },
    replacement: { expectedImageUrl: OLD, expectedIsCustom: true },
    ...overrides,
  });
  // Category reads come in order: the pre-upload check, then the read after a failed write.
  function prismaWith(categoryReads: unknown[], updateCount = 1, library: unknown = null) {
    return {
      emojiLibraryItem: {
        findUnique: vi.fn().mockResolvedValue(library),
        create: vi.fn().mockResolvedValue({}),
        upsert: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      category: {
        findUnique: vi.fn(async () => categoryReads.shift() ?? null),
        updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
        update: vi.fn(),
      },
    };
  }

  it('refuses a replacement without its authorised old URL before any upload', async () => {
    const prisma = prismaWith([{ imageUrl: OLD, isCustom: true }]);
    const upload = vi.fn().mockResolvedValue(NEW);
    await expect(
      applyCell(prisma as unknown as PrismaClient, planFor({ replacement: undefined }), upload)
    ).rejects.toThrow('needs its authorised old URL (--replace-auth)');
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.emojiLibraryItem.create).not.toHaveBeenCalled();
    expect(prisma.category.updateMany).not.toHaveBeenCalled();
  });

  it('swaps the picture with one write conditional on the authorised old URL', async () => {
    const prisma = prismaWith([{ imageUrl: OLD, isCustom: true }]);
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(prisma as unknown as PrismaClient, planFor(), upload);

    expect(result).toMatchObject({ product: 'category', changed: true, uploaded: 1 });
    expect(prisma.category.updateMany).toHaveBeenCalledWith({
      where: { id: 'c-drinks', imageUrl: OLD, isCustom: true },
      data: { isCustom: true, imageUrl: NEW },
    });
  });

  it('leaves a manual edit alone and uploads nothing when the old URL no longer matches', async () => {
    const prisma = prismaWith([{ imageUrl: MANUAL, isCustom: true }]);
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(prisma as unknown as PrismaClient, planFor(), upload);

    expect(result.product).toBe('conflict');
    expect(result.conflict).toContain('не содержит ожидаемую старую картинку');
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.category.updateMany).not.toHaveBeenCalled();
  });

  // The library record a previous run wrote for this cell: its picture is the new URL.
  const LIBRARY = {
    id: 'lib-1',
    sourceRef: 'queue-011#1',
    name: 'Напитки',
    nameEn: 'Beverages',
    tags: ['напитки', 'queue:category'],
    imageUrl: NEW,
    source: 'batch',
    locale: null,
    groupKey: 'queue-011#1',
  };

  it('resumes a run that stopped after the library write, with no second upload', async () => {
    const prisma = prismaWith([{ imageUrl: OLD, isCustom: true }], 1, LIBRARY);
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(prisma as unknown as PrismaClient, planFor(), upload);

    expect(result).toMatchObject({ product: 'category', changed: true, uploaded: 0 });
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.category.updateMany).toHaveBeenCalledWith({
      where: { id: 'c-drinks', imageUrl: OLD, isCustom: true },
      data: { isCustom: true, imageUrl: NEW },
    });
  });

  it('recognises a run that finished between the reads instead of refusing it', async () => {
    const prisma = prismaWith(
      [
        { imageUrl: NEW, isCustom: true },
        { imageUrl: NEW, isCustom: true },
      ],
      0
    );
    // The first read of the library record sees nothing; the concurrent run's record is there after.
    prisma.emojiLibraryItem.findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(LIBRARY);
    const upload = vi.fn().mockResolvedValue('https://unused.example.test/x.webp');
    const result = await applyCell(prisma as unknown as PrismaClient, planFor(), upload);

    expect(result).toMatchObject({ product: 'category', changed: false, uploaded: 0 });
    expect(upload).not.toHaveBeenCalled();
  });

  it('reports a replay as unchanged once the category already holds the new URL', async () => {
    const prisma = prismaWith(
      [
        { imageUrl: NEW, isCustom: true },
        { imageUrl: NEW, isCustom: true },
      ],
      0,
      LIBRARY
    );
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(
      prisma as unknown as PrismaClient,
      planFor({ replacement: { expectedImageUrl: OLD, expectedIsCustom: true } }),
      upload
    );

    expect(result).toMatchObject({ product: 'category', changed: false, uploaded: 0 });
    expect(result.conflict).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });

  it('conflicts, and keeps the concurrent value, when a write lands between the read and the update', async () => {
    const prisma = prismaWith(
      [
        { imageUrl: OLD, isCustom: true },
        { imageUrl: MANUAL, isCustom: true },
      ],
      0
    );
    // The other writer changes the category while this run is uploading.
    const upload = vi.fn(async () => NEW);
    const result = await applyCell(prisma as unknown as PrismaClient, planFor(), upload);

    expect(result.product).toBe('conflict');
    expect(result.conflict).toContain('изменилась после проверки');
    expect(prisma.category.updateMany).toHaveBeenCalledTimes(1);
  });

  it('keeps a replacement that another run wrote with the same picture as one success', async () => {
    const prisma = prismaWith(
      [
        { imageUrl: OLD, isCustom: true },
        { imageUrl: NEW, isCustom: false },
      ],
      0
    );
    const result = await applyCell(
      prisma as unknown as PrismaClient,
      planFor(),
      vi.fn().mockResolvedValue(NEW)
    );
    // A new URL without the custom flag is not the applied state: it is refused, not overwritten.
    expect(result.product).toBe('conflict');
  });

  it('swaps an authorised original with isCustom false and sets the flag with the picture', async () => {
    const prisma = prismaWith([{ imageUrl: OLD, isCustom: false }]);
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(
      prisma as unknown as PrismaClient,
      planFor({ replacement: { expectedImageUrl: OLD, expectedIsCustom: false } }),
      upload
    );

    expect(result).toMatchObject({ product: 'category', changed: true, uploaded: 1 });
    expect(prisma.category.updateMany).toHaveBeenCalledWith({
      where: { id: 'c-drinks', imageUrl: OLD, isCustom: false },
      data: { isCustom: true, imageUrl: NEW },
    });
  });

  it('leaves a manual mode change made before the run alone when the URL still matches', async () => {
    const prisma = prismaWith([{ imageUrl: OLD, isCustom: false }]);
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(prisma as unknown as PrismaClient, planFor(), upload);

    expect(result.product).toBe('conflict');
    expect(result.conflict).toContain('не содержит ожидаемую старую картинку и режим');
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.emojiLibraryItem.create).not.toHaveBeenCalled();
    expect(prisma.category.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a manual mode change that lands between the read and the update', async () => {
    const prisma = prismaWith(
      [
        { imageUrl: OLD, isCustom: true },
        { imageUrl: OLD, isCustom: false },
      ],
      0
    );
    // Same URL, mode switched off by hand while this run uploads: the conditional write must not match.
    const upload = vi.fn(async () => NEW);
    const result = await applyCell(prisma as unknown as PrismaClient, planFor(), upload);

    expect(result.product).toBe('conflict');
    expect(result.conflict).toContain('изменилась после проверки');
    expect(prisma.category.updateMany).toHaveBeenCalledWith({
      where: { id: 'c-drinks', imageUrl: OLD, isCustom: true },
      data: { isCustom: true, imageUrl: NEW },
    });
  });

  it('does not treat a replay as applied once the mode was switched off by hand', async () => {
    const prisma = prismaWith([{ imageUrl: NEW, isCustom: false }], 1, LIBRARY);
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(
      prisma as unknown as PrismaClient,
      planFor({ replacement: { expectedImageUrl: OLD, expectedIsCustom: true } }),
      upload
    );

    expect(result.product).toBe('conflict');
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.category.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a null URL with no library record before any upload or library write', async () => {
    const prisma = prismaWith([{ imageUrl: null, isCustom: true }]);
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(prisma as unknown as PrismaClient, planFor(), upload);

    expect(result.product).toBe('conflict');
    expect(result.conflict).toContain('не содержит ожидаемую старую картинку');
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.emojiLibraryItem.create).not.toHaveBeenCalled();
    expect(prisma.emojiLibraryItem.upsert).not.toHaveBeenCalled();
    expect(prisma.category.updateMany).not.toHaveBeenCalled();
  });

  it("does not treat an unowned URL that merely equals the new one as this cell's replay", async () => {
    const prisma = prismaWith([{ imageUrl: NEW, isCustom: true }]);
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(prisma as unknown as PrismaClient, planFor(), upload);

    expect(result.product).toBe('conflict');
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.category.updateMany).not.toHaveBeenCalled();
  });

  it('never replaces a category picture for an ambiguous or missing category', async () => {
    const prisma = prismaWith([{ imageUrl: OLD, isCustom: true }]);
    const upload = vi.fn().mockResolvedValue(NEW);
    const result = await applyCell(
      prisma as unknown as PrismaClient,
      planFor({ product: { kind: 'not-found', reason: 'нет категории «Напитки»' } }),
      upload
    );
    expect(result.product).toBe('not-found');
    expect(prisma.category.updateMany).not.toHaveBeenCalled();
  });
});

describe('the replacement authorisation file (AGE-1667 C6)', () => {
  const manifest: ManifestBatch[] = [
    {
      batch: 'queue-010',
      file: 'queue-010.png',
      cells: [
        {
          cell: 1,
          category: 'Овощи',
          name: 'Овощи',
          nameEn: 'Vegetables',
          action: 'update-image',
          target: 'category',
        },
      ],
    },
    {
      batch: 'queue-011',
      file: 'queue-011.png',
      cells: [
        {
          cell: 1,
          category: 'Напитки',
          name: 'Напитки',
          nameEn: 'Beverages',
          action: 'replace',
          target: 'category',
        },
        {
          cell: 2,
          category: 'Рыба и морепродукты',
          name: 'Рыба и морепродукты',
          nameEn: 'Fish & Seafood',
          action: 'replace',
          target: 'category',
        },
      ],
    },
  ];
  const selected = [manifest[1]];
  const entry = (
    category: string,
    expectedImageUrl = 'https://cdn.example.test/old.webp',
    expectedIsCustom: unknown = true
  ) => ({
    category,
    expectedImageUrl,
    expectedIsCustom,
  });
  const file = (...replacements: unknown[]) => ({ replacements });

  it('accepts one exact entry per selected replacement', () => {
    const map = parseReplacementAuthorization(
      file(entry('Напитки'), entry('Рыба и морепродукты')),
      manifest,
      selected
    );
    expect([...map.keys()]).toEqual(['напитки', 'рыба и морепродукты']);
    expect(map.get('напитки')).toEqual({
      expectedImageUrl: 'https://cdn.example.test/old.webp',
      expectedIsCustom: true,
    });
  });

  it('keeps the authorised isCustom flag, false as well as true', () => {
    const map = parseReplacementAuthorization(
      file(entry('Напитки', undefined, false), entry('Рыба и морепродукты', undefined, true)),
      manifest,
      selected
    );
    expect(map.get('напитки')?.expectedIsCustom).toBe(false);
    expect(map.get('рыба и морепродукты')?.expectedIsCustom).toBe(true);
  });

  it('refuses an entry without expectedIsCustom or with a non-boolean one', () => {
    expect(() =>
      parseReplacementAuthorization(
        file(
          { category: 'Напитки', expectedImageUrl: 'https://cdn.example.test/a.webp' },
          entry('Рыба и морепродукты')
        ),
        manifest,
        selected
      )
    ).toThrow('ровно поля "category", "expectedImageUrl" и "expectedIsCustom"');
    for (const bad of ['true', 1, null]) {
      expect(() =>
        parseReplacementAuthorization(
          file(entry('Напитки', undefined, bad), entry('Рыба и морепродукты')),
          manifest,
          selected
        )
      ).toThrow('expectedIsCustom должен быть true или false');
    }
  });

  it('refuses a missing replacement before anything is read', () => {
    expect(() => parseReplacementAuthorization(file(entry('Напитки')), manifest, selected)).toThrow(
      'нет записей для замены: рыба и морепродукты'
    );
  });

  it('refuses an unknown, duplicate or non-replacement category', () => {
    expect(() =>
      parseReplacementAuthorization(file(entry('Напитки'), entry('Молоко')), manifest, selected)
    ).toThrow('не заменяемая категория');
    expect(() =>
      parseReplacementAuthorization(
        file(entry('Напитки'), entry('напитки'), entry('Рыба и морепродукты')),
        manifest,
        selected
      )
    ).toThrow('указана дважды');
    expect(() =>
      parseReplacementAuthorization(
        file(entry('Напитки'), entry('Рыба и морепродукты'), entry('Овощи')),
        manifest,
        selected
      )
    ).toThrow('не заменяемая категория');
  });

  it('refuses a URL that is not an absolute https address, and extra or missing fields', () => {
    const insecureUrl = 'http://cdn.example.test/a.webp';
    expect(() =>
      parseReplacementAuthorization(
        file(entry('Напитки', insecureUrl), entry('Рыба и морепродукты')),
        manifest,
        selected
      )
    ).toThrow('нужен абсолютный https-адрес');
    expect(() =>
      parseReplacementAuthorization(
        file(entry('Напитки', 'not a url'), entry('Рыба и морепродукты')),
        manifest,
        selected
      )
    ).toThrow('URL не разобран');
    expect(() =>
      parseReplacementAuthorization(
        file(
          { category: 'Напитки', expectedImageUrl: 'https://cdn.example.test/a.webp', note: 'x' },
          entry('Рыба и морепродукты')
        ),
        manifest,
        selected
      )
    ).toThrow('ровно поля');
    expect(() =>
      parseReplacementAuthorization(
        file({ category: 'Напитки' }, entry('Рыба и морепродукты')),
        manifest,
        selected
      )
    ).toThrow('ровно поля');
  });

  it('refuses a malformed top level', () => {
    expect(() => parseReplacementAuthorization([], manifest, selected)).toThrow('ожидается объект');
    expect(() => parseReplacementAuthorization({ replacements: {} }, manifest, selected)).toThrow(
      'должно быть массивом'
    );
    expect(() =>
      parseReplacementAuthorization({ replacements: [], extra: 1 }, manifest, selected)
    ).toThrow('неизвестное поле');
  });

  it('accepts entries for replacements outside the selected batches', () => {
    const map = parseReplacementAuthorization(
      file(entry('Напитки'), entry('Рыба и морепродукты')),
      manifest,
      []
    );
    expect(map.size).toBe(2);
  });
});

// The English picture is the `en` entry of the dictionary. An import writes that entry only and
// never touches the entries of other languages, whether or not the picture list covers them.
describe('an import keeps the other languages of the dictionary (AGE-1667 Ya3)', () => {
  const RU = 'https://utfs.io/f/ru.webp';
  const EN = 'https://utfs.io/f/en.webp';
  const ES = 'https://utfs.io/f/es.webp';
  const ES_LATE = 'https://utfs.io/f/es-late.webp';
  const REF = 'queue-001#1';

  type Kind = 'product' | 'variant';
  const cellOf = (kind: Kind): ManifestCell => ({
    cell: 1,
    target: kind,
    ...(kind === 'variant' ? { parent: 'Яблоко' } : {}),
    category: 'Фрукты',
    name: 'Груша',
    nameEn: 'Pear',
    action: 'update-image',
  });
  const planOf = (kind: Kind, mode: 'text' | 'universal', withEn: boolean): CellPlan => ({
    ref: REF,
    batch: 'queue-001',
    batchKind: mode,
    cell: cellOf(kind),
    images: withEn ? { ru: Buffer.from('ru'), en: Buffer.from('en') } : { ru: Buffer.from('ru') },
    stored: {},
    product:
      kind === 'product'
        ? { kind: 'link', productId: 'pear', productName: 'Груша' }
        : { kind: 'variant', variantId: 'v-pear', productName: 'Яблоко', variantName: 'Груша' },
  });
  const rowOf = (kind: Kind, slots: Record<string, unknown> = {}) =>
    ({
      id: kind === 'product' ? 'pear' : 'v-pear',
      imageUrl: null,
      localizedImages: null,
      isCustom: false,
      ...slots,
    }) as Row;
  const prismaOf = (kind: Kind, row: Row) => {
    const record = liveRow(row);
    return {
      prisma: {
        ...noCatalogue(),
        emojiLibraryItem: memoryLibrary(),
        ...(kind === 'product' ? { product: record } : { productVariant: record }),
      } as unknown as PrismaClient,
      record,
    };
  };
  const upload = () => vi.fn(async (image: Buffer) => (image.toString() === 'en' ? EN : RU));

  it.each(['product', 'variant'] as const)(
    'adds the English entry beside an entry of another language (%s)',
    async (kind) => {
      const row = rowOf(kind, { localizedImages: { es: ES } });
      const { prisma, record } = prismaOf(kind, row);

      const result = await applyCell(prisma, planOf(kind, 'text', true), upload());

      expect(result).toMatchObject({ changed: true, conflict: undefined });
      expect(row).toMatchObject({ imageUrl: RU, localizedImages: { es: ES, en: EN } });
      // The write is conditioned on the dictionary exactly as it was read.
      expect(record.updateMany).toHaveBeenCalledWith({
        where: {
          id: row.id,
          imageUrl: null,
          localizedImages: { equals: { es: ES } },
          imageUrlEn: null,
        },
        data: expect.objectContaining({ localizedImages: { es: ES, en: EN }, imageUrlEn: EN }),
      });
    }
  );

  it.each(['product', 'variant'] as const)(
    'removes only the English entry when a text-free picture is queued (%s)',
    async (kind) => {
      const row = rowOf(kind, { localizedImages: { es: ES } });
      const { prisma } = prismaOf(kind, row);

      const result = await applyCell(prisma, planOf(kind, 'universal', false), upload());

      expect(result).toMatchObject({ changed: true, conflict: undefined });
      expect(row).toMatchObject({ imageUrl: RU, localizedImages: { es: ES }, imageUrlEn: null });
    }
  );

  it.each(['product', 'variant'] as const)(
    'refuses a queue write when another language is added between the read and the write (%s)',
    async (kind) => {
      const row = rowOf(kind, { localizedImages: { es: ES } });
      const { prisma, record } = prismaOf(kind, row);
      // The dictionary changes after this run has read it.
      record.findUnique.mockImplementationOnce(async () => {
        const seen = { ...row };
        row.localizedImages = { es: ES, fr: ES_LATE };
        return seen;
      });

      const result = await applyCell(prisma, planOf(kind, 'text', true), upload());

      expect(result).toMatchObject({ product: 'conflict' });
      expect(row).toMatchObject({ imageUrl: null, localizedImages: { es: ES, fr: ES_LATE } });
    }
  );

  it.each(['product', 'variant'] as const)(
    'does not lose an entry added between the read and the write of a historical cell (%s)',
    async (kind) => {
      const row = rowOf(kind, {
        imageUrl: 'https://utfs.io/f/old.webp',
        localizedImages: { es: ES },
      });
      const { prisma, record } = prismaOf(kind, row);
      record.findUnique.mockImplementationOnce(async () => {
        const seen = { ...row };
        row.localizedImages = { es: ES, fr: ES_LATE };
        return seen;
      });
      const historical = planOf(kind, 'text', true);
      historical.cell = { ...historical.cell, target: undefined, parent: undefined };
      historical.product =
        kind === 'product'
          ? { kind: 'link', productId: 'pear', productName: 'Груша' }
          : { kind: 'variant', variantId: 'v-pear', productName: 'Яблоко', variantName: 'Груша' };

      const result = await applyCell(prisma, historical, upload());

      expect(result.product).toBe('conflict');
      expect(row.localizedImages).toEqual({ es: ES, fr: ES_LATE });
    }
  );

  it.each(['product', 'variant'] as const)(
    'writes nothing on a repeat when the dictionary already holds the entry (%s)',
    async (kind) => {
      const row = rowOf(kind, {
        imageUrl: RU,
        localizedImages: { es: ES, en: EN },
        isCustom: true,
      });
      const { prisma, record } = prismaOf(kind, row);
      const library = memoryLibrary([
        {
          sourceRef: REF,
          imageUrl: RU,
          name: 'Груша',
          nameEn: 'Pear',
          tags: libraryTags(cellOf(kind)),
          source: 'batch',
          locale: 'ru',
          groupKey: REF,
        },
        {
          sourceRef: `${REF}:en`,
          imageUrl: EN,
          name: 'Груша',
          nameEn: 'Pear',
          tags: libraryTags(cellOf(kind)),
          source: 'batch',
          locale: 'en',
          groupKey: REF,
        },
      ]);
      (prisma as unknown as { emojiLibraryItem: unknown }).emojiLibraryItem = library;

      const result = await applyCell(prisma, planOf(kind, 'text', true), vi.fn());

      expect(result).toMatchObject({ changed: false, uploaded: 0, conflict: undefined });
      expect(record.updateMany).not.toHaveBeenCalled();
      expect(record.update).not.toHaveBeenCalled();
    }
  );
});

// The legacy English column is written by the previous release alone, so a row can hold the only
// address of its English picture there (the dictionary has none), already or from between this
// run's read and its write. The import never reads the column; the database write is conditioned
// on it being empty, together with the dictionary as read, and a row that fails it keeps its
// address (AGE-1667 Ya3, review round 4).
describe('a queue write keeps an English address only the previous release holds (AGE-1667 Ya3)', () => {
  const RU = 'https://utfs.io/f/ru.webp';
  const EN = 'https://utfs.io/f/en.webp';
  const LEGACY = 'https://utfs.io/f/legacy-only.webp';
  const REF = 'queue-001#1';

  type Kind = 'product' | 'variant';
  type Mode = { label: string; batchKind: 'text' | 'universal'; withEn: boolean };
  const MODES: Mode[] = [
    { label: 'text, Russian and English sheets', batchKind: 'text', withEn: true },
    { label: 'text, Russian sheet only', batchKind: 'text', withEn: false },
    { label: 'universal, text-free picture', batchKind: 'universal', withEn: false },
  ];
  const CASES = (['product', 'variant'] as const).flatMap((kind) =>
    MODES.map((mode) => [kind, mode.label, mode] as const)
  );

  const cellOf = (kind: Kind): ManifestCell => ({
    cell: 1,
    target: kind,
    ...(kind === 'variant' ? { parent: 'Яблоко' } : {}),
    category: 'Фрукты',
    name: 'Груша',
    nameEn: 'Pear',
    action: 'update-image',
  });
  const planOf = (kind: Kind, { batchKind, withEn }: Mode): CellPlan => ({
    ref: REF,
    batch: 'queue-001',
    batchKind,
    cell: cellOf(kind),
    images: withEn ? { ru: Buffer.from('ru'), en: Buffer.from('en') } : { ru: Buffer.from('ru') },
    stored: {},
    product:
      kind === 'product'
        ? { kind: 'link', productId: 'pear', productName: 'Груша' }
        : { kind: 'variant', variantId: 'v-pear', productName: 'Яблоко', variantName: 'Груша' },
  });
  const rowOf = (kind: Kind, slots: Record<string, unknown> = {}) =>
    ({
      id: kind === 'product' ? 'pear' : 'v-pear',
      imageUrl: null,
      localizedImages: null,
      imageUrlEn: null,
      isCustom: false,
      ...slots,
    }) as Row;
  const prismaOf = (kind: Kind, row: Row, library = memoryLibrary()) => {
    const record = liveRow(row);
    return {
      prisma: {
        ...noCatalogue(),
        emojiLibraryItem: library,
        ...(kind === 'product' ? { product: record } : { productVariant: record }),
      } as unknown as PrismaClient,
      record,
    };
  };
  const upload = () => vi.fn(async (image: Buffer) => (image.toString() === 'en' ? EN : RU));
  // The previous release writes its English address after this run has read the row.
  const oldWriterAfterRead = (record: ReturnType<typeof liveRow>, row: Row) =>
    record.findUnique.mockImplementationOnce(async () => {
      const seen = { ...row };
      row.imageUrlEn = LEGACY;
      return seen;
    });
  // The record is read for its pictures and nothing else: no legacy column is selected.
  const readsNoLegacy = (record: ReturnType<typeof liveRow>) => {
    for (const [args] of record.findUnique.mock.calls as unknown as [{ select?: object }][]) {
      expect(Object.keys(args.select ?? {})).not.toContain('imageUrlEn');
    }
  };

  it.each(CASES)(
    'keeps an address already in the legacy column of a free record (%s, %s)',
    async (kind, _label, mode) => {
      const row = rowOf(kind, { imageUrlEn: LEGACY });
      const { prisma, record } = prismaOf(kind, row);

      const result = await applyCell(prisma, planOf(kind, mode), upload());

      expect(result).toMatchObject({ product: 'conflict' });
      expect(result.conflict).toBeDefined();
      expect(row).toMatchObject({
        imageUrl: null,
        localizedImages: null,
        imageUrlEn: LEGACY,
        isCustom: false,
      });
      expect(record.updateMany).toHaveBeenCalledTimes(1);
      expect(record.updateMany.mock.calls[0][0].where).toMatchObject({ imageUrlEn: null });
      expect(record.update).not.toHaveBeenCalled();
      readsNoLegacy(record);
    }
  );

  it.each(CASES)(
    'keeps an address written to the legacy column after the read (%s, %s)',
    async (kind, _label, mode) => {
      const row = rowOf(kind);
      const { prisma, record } = prismaOf(kind, row);
      oldWriterAfterRead(record, row);

      const result = await applyCell(prisma, planOf(kind, mode), upload());

      expect(result).toMatchObject({ product: 'conflict' });
      expect(result.conflict).toBeDefined();
      expect(row).toMatchObject({
        imageUrl: null,
        localizedImages: null,
        imageUrlEn: LEGACY,
        isCustom: false,
      });
      expect(record.updateMany).toHaveBeenCalledTimes(1);
      expect(record.update).not.toHaveBeenCalled();
      readsNoLegacy(record);
    }
  );

  it.each(['product', 'variant'] as const)(
    'still writes a free record whose legacy column is empty (%s)',
    async (kind) => {
      const row = rowOf(kind);
      const { prisma, record } = prismaOf(kind, row);

      const result = await applyCell(prisma, planOf(kind, MODES[0]), upload());

      expect(result).toMatchObject({ changed: true, conflict: undefined });
      expect(row).toMatchObject({ imageUrl: RU, localizedImages: { en: EN }, imageUrlEn: EN });
      expect(record.updateMany.mock.calls[0][0].where).toMatchObject({ imageUrlEn: null });
    }
  );

  // A Russian picture this cell stored, its English sheet queued later: only an empty English slot
  // is filled, and the legacy column counts as part of that slot.
  describe.each(['product', 'variant'] as const)(
    'an English sheet after the Russian one (%s)',
    (kind) => {
      const first = () => ({ ...planOf(kind, MODES[1]) });
      const second = () => ({ ...planOf(kind, MODES[0]) });

      it('keeps an address already in the legacy column', async () => {
        const row = rowOf(kind);
        const { prisma, record } = prismaOf(kind, row);
        await applyCell(prisma, first(), upload());
        expect(row).toMatchObject({ imageUrl: RU, localizedImages: null });
        // The previous release writes its English address between the two runs.
        row.imageUrlEn = LEGACY;

        const result = await applyCell(prisma, second(), upload());

        expect(result).toMatchObject({ product: 'conflict' });
        expect(row).toMatchObject({ imageUrl: RU, localizedImages: null, imageUrlEn: LEGACY });
        expect(record.updateMany).toHaveBeenCalledTimes(2);
        expect(record.updateMany.mock.calls[1][0].where).toMatchObject({
          imageUrl: RU,
          imageUrlEn: null,
        });
        readsNoLegacy(record);
      });

      it('keeps an address written to the legacy column after the read', async () => {
        const row = rowOf(kind);
        const { prisma, record } = prismaOf(kind, row);
        await applyCell(prisma, first(), upload());
        oldWriterAfterRead(record, row);

        const result = await applyCell(prisma, second(), upload());

        expect(result).toMatchObject({ product: 'conflict' });
        expect(row).toMatchObject({ imageUrl: RU, localizedImages: null, imageUrlEn: LEGACY });
        expect(record.updateMany).toHaveBeenCalledTimes(2);
        readsNoLegacy(record);
      });

      it('fills the empty English slot when nothing is in the legacy column', async () => {
        const row = rowOf(kind);
        const { prisma } = prismaOf(kind, row);
        await applyCell(prisma, first(), upload());

        const result = await applyCell(prisma, second(), upload());

        expect(result).toMatchObject({ changed: true, conflict: undefined });
        expect(row).toMatchObject({ imageUrl: RU, localizedImages: { en: EN }, imageUrlEn: EN });
      });
    }
  );
});
