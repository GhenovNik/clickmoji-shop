// @vitest-environment node
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findBatchFiles } from './emoji-batch-import';
import {
  catalogueTargets,
  main,
  planQueueBatches,
  validateQueue,
  type QueueItem,
} from '../../../scripts/emoji-queue';

const DOCS = 'docs/emoji-batches';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const snapshot = JSON.parse(readFileSync(join(DOCS, 'catalog-snapshot-2026-11-25.json'), 'utf8'));
const candidates = JSON.parse(readFileSync(join(DOCS, 'queue-candidates.json'), 'utf8'))
  .items as QueueItem[];

describe('queue of the 144 catalogue targets (AGE-1667 C6)', () => {
  it('matches the snapshot exactly: 123 products, 2 variants, 19 categories', () => {
    expect(() => validateQueue(candidates, snapshot)).not.toThrow();
    const count = (target: string) => candidates.filter((item) => item.target === target).length;
    expect(count('product')).toBe(123);
    expect(count('variant')).toBe(2);
    expect(count('category')).toBe(19);
    expect(catalogueTargets(snapshot)).toHaveLength(144);
    expect(candidates).toHaveLength(144);
  });

  it('replaces exactly the five snapshot categories that already have a picture', () => {
    const replaced = candidates.filter((item) => item.action === 'replace');
    expect(replaced.map((item) => item.name)).toEqual([
      'Напитки',
      'Крупы и макароны',
      'Орехи и Сухофрукты',
      'Масла и соусы',
      'Рыба и морепродукты',
    ]);
    expect(replaced.every((item) => item.target === 'category')).toBe(true);
    expect(candidates.filter((item) => item.action === 'update-image')).toHaveLength(139);
  });

  it('asks every category cell for exactly three most recognizable items', () => {
    const categories = candidates.filter((item) => item.target === 'category');
    expect(categories.every((item) => item.hint?.startsWith('exactly three '))).toBe(true);
  });

  it('keeps the 139 earlier targets first and appends the five replacements (queue-011)', () => {
    const batches = planQueueBatches(candidates);
    expect(batches.filter((b) => b.kind === 'universal')).toHaveLength(11);
    const last = batches.find((b) => b.id === 'queue-011')!;
    expect(last.items.map((item) => item.action)).toEqual(Array(5).fill('replace'));
    expect(batches.filter((b) => b.kind === 'text')).toHaveLength(6);
  });

  it('splits 49 labelled products into text batches and the rest into text-free batches', () => {
    const batches = planQueueBatches(candidates);
    const universal = batches.filter((b) => b.kind === 'universal');
    const text = batches.filter((b) => b.kind === 'text');
    expect(universal).toHaveLength(11);
    expect(text).toHaveLength(6);
    expect(text.flatMap((b) => b.items)).toHaveLength(49);
    expect(text.flatMap((b) => b.items).every((item) => item.target === 'product')).toBe(true);
    expect(universal.flatMap((b) => b.items).some((item) => item.text)).toBe(false);
  });

  it('keeps every batch within nine cells and every record in exactly one batch', () => {
    const batches = planQueueBatches(candidates);
    expect(batches.every((b) => b.items.length <= 9)).toBe(true);
    const names = batches.flatMap((b) => b.items.map((item) => `${item.target}:${item.name}`));
    expect(new Set(names).size).toBe(144);
  });

  it('uses batch ids that do not prefix each other on disk', () => {
    const ids = planQueueBatches(candidates).map((b) => b.id);
    for (const id of ids) {
      for (const other of ids) if (id !== other) expect(other.startsWith(id)).toBe(false);
    }
    const dir = mkdtempSync(join(tmpdir(), 'emoji-queue-ids-'));
    dirs.push(dir);
    for (const name of ['queue-001.png', 'queue-text-001.png', 'queue-text-001-en.png']) {
      writeFileSync(join(dir, name), '');
    }
    expect(findBatchFiles(dir, 'queue-001').sheet).toBe(join(dir, 'queue-001.png'));
    expect(findBatchFiles(dir, 'queue-001').sheetEn).toBeUndefined();
    expect(findBatchFiles(dir, 'queue-text-001').sheetEn).toBe(join(dir, 'queue-text-001-en.png'));
  });

  it('is reproduced byte for byte by the generator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emoji-queue-'));
    dirs.push(dir);
    copyFileSync(join(DOCS, 'queue-candidates.json'), join(dir, 'queue-candidates.json'));
    copyFileSync(
      join(DOCS, 'catalog-snapshot-2026-11-25.json'),
      join(dir, 'catalog-snapshot-2026-11-25.json')
    );
    await main(dir);
    expect(readFileSync(join(dir, 'queue-manifest.json'), 'utf8')).toBe(
      readFileSync(join(DOCS, 'queue-manifest.json'), 'utf8')
    );
  });
});

describe('queue validation', () => {
  const product = candidates.find((item) => item.target === 'product')!;

  it('names a record that is missing from the queue', () => {
    expect(() => validateQueue(candidates.slice(1), snapshot)).toThrow(
      `missing: ${candidates[0].target} «${candidates[0].name}»`
    );
  });

  it('refuses a record that already has a picture in the snapshot', () => {
    const withPicture = { ...product, name: 'Артишок', nameEn: 'Artichoke', category: 'Овощи' };
    expect(() => validateQueue([...candidates, withPicture], snapshot)).toThrow(
      'not a catalogue target: product «Артишок»'
    );
  });

  it('refuses a duplicate record', () => {
    expect(() => validateQueue([...candidates, product], snapshot)).toThrow(
      `duplicate: product «${product.name}»`
    );
  });

  it('refuses an English name that differs from the snapshot', () => {
    const wrong = candidates.map((item) =>
      item === product ? { ...item, nameEn: 'Wrong' } : item
    );
    expect(() => validateQueue(wrong, snapshot)).toThrow('nameEn differs');
  });

  it('refuses a replacement for a category that has no picture, and a missing replacement', () => {
    const replaced = candidates.find((item) => item.action === 'replace')!;
    const asUpdate = candidates.map((item) =>
      item === replaced ? { ...item, action: 'update-image' as const } : item
    );
    expect(() => validateQueue(asUpdate, snapshot)).toThrow(
      `action differs from the snapshot: category «${replaced.name}» is replace, not update-image`
    );
    const emptyCategory = candidates.find(
      (item) => item.target === 'category' && item.action === 'update-image'
    )!;
    const asReplace = candidates.map((item) =>
      item === emptyCategory ? { ...item, action: 'replace' as const } : item
    );
    expect(() => validateQueue(asReplace, snapshot)).toThrow(
      `category «${emptyCategory.name}» is update-image, not replace`
    );
  });

  it('refuses a category whose prompt does not ask for exactly three items', () => {
    const category = candidates.find((item) => item.target === 'category')!;
    const loose = candidates.map((item) =>
      item === category ? { ...item, hint: 'two or three items together' } : item
    );
    expect(() => validateQueue(loose, snapshot)).toThrow('must ask for exactly three items');
  });

  it('refuses a category with text on it', () => {
    const category = candidates.find((item) => item.target === 'category')!;
    const labelled = candidates.map((item) => (item === category ? { ...item, text: true } : item));
    expect(() => validateQueue(labelled, snapshot)).toThrow('cannot carry text');
  });

  it('writes nothing when the queue does not match the snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emoji-queue-bad-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'queue'));
    writeFileSync(join(dir, 'queue', 'queue-001.md'), 'kept');
    writeFileSync(join(dir, 'queue-manifest.json'), 'kept manifest');
    writeFileSync(
      join(dir, 'queue-candidates.json'),
      JSON.stringify({ items: candidates.slice(1) })
    );
    copyFileSync(
      join(DOCS, 'catalog-snapshot-2026-11-25.json'),
      join(dir, 'catalog-snapshot-2026-11-25.json')
    );

    await expect(main(dir)).rejects.toThrow('Queue does not match the snapshot');
    expect(readFileSync(join(dir, 'queue', 'queue-001.md'), 'utf8')).toBe('kept');
    expect(readFileSync(join(dir, 'queue-manifest.json'), 'utf8')).toBe('kept manifest');
  });
});
