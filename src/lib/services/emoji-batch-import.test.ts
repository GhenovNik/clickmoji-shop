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
import type { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readBatchImages,
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

describe('readBatchImages gap clearing', () => {
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
  const index = {
    products: new Map([
      [normalizeCatalogName('Сгущённое молоко'), [{ id: 'p1', name: 'Сгущенное молоко' }]],
      [
        normalizeCatalogName('Чай'),
        [
          { id: 'a', name: 'Чай' },
          { id: 'b', name: ' чай ' },
        ],
      ],
    ]),
    variants: new Map(),
    categories: new Map([
      [
        normalizeCatalogName('Молочные продукты'),
        { id: 'c1', name: 'Молочные продукты', emoji: '🥛' },
      ],
    ]),
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
  const apple = { id: 'apple', name: 'Яблоко' };
  const index = {
    products: new Map([
      [normalizeCatalogName('Яблоко'), [apple]],
      [normalizeCatalogName('Хлеб'), [{ id: 'bread', name: 'Хлеб' }]],
      [
        normalizeCatalogName('Дубль'),
        [
          { id: 'd1', name: 'Дубль' },
          { id: 'd2', name: 'Дубль' },
        ],
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
      planProduct(target({ target: 'variant', parent: 'Хлеб', name: 'Хлеб белый' }), index)
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
    expect(planProduct(target({ target: 'category', name: 'Овощи' }), index)).toEqual({
      kind: 'not-found',
      reason: 'нет категории «Овощи»',
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
      },
      productVariant: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      category: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
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

  it('removes a fresh upload whose library record failed, so a re-run does not orphan it', async () => {
    const prisma = fakePrisma();
    prisma.emojiLibraryItem.upsert.mockRejectedValueOnce(new Error('db down'));
    const upload = vi.fn(async () => 'https://utfs.io/f/fresh.webp');
    const discard = vi.fn(async () => undefined);

    await expect(
      applyCell(prisma as unknown as PrismaClient, plan(), upload, discard)
    ).rejects.toThrow('db down');

    expect(discard).toHaveBeenCalledWith('https://utfs.io/f/fresh.webp');
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('never removes a picture that was already stored before this run', async () => {
    const prisma = fakePrisma();
    prisma.emojiLibraryItem.upsert.mockRejectedValueOnce(new Error('db down'));
    const discard = vi.fn(async () => undefined);

    await expect(
      applyCell(
        prisma as unknown as PrismaClient,
        plan({ stored: { ru: 'https://utfs.io/f/old.webp' } }),
        vi.fn(),
        discard
      )
    ).rejects.toThrow('db down');

    expect(discard).not.toHaveBeenCalled();
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
        findUnique: vi.fn().mockResolvedValue(null),
      },
      product: {
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      productVariant: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      category: {
        update: vi.fn().mockResolvedValue({}),
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
    expect(prisma.productVariant.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
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

    expect(prisma.category.update).toHaveBeenCalledWith({
      where: { id: 'c2' },
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
    expect(prisma.emojiLibraryItem.upsert).toHaveBeenCalledTimes(1);
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
      tags: ['фрукты'],
      source: 'batch',
      locale: null,
      groupKey: 'queue-001#1',
    });
    prisma.productVariant.findUnique.mockResolvedValue({ imageUrl: stored, imageUrlEn: null });
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
