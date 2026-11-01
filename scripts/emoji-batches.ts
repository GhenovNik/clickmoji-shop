import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Builds the emoji batches for the operator (AGE-1465 item 1): docs/emoji-batches/candidates.json
// minus the catalog snapshot → batches of 9 with a ready Gemini prompt and a cell manifest.
// Usage: npx tsx scripts/emoji-batches.ts

const DIR = 'docs/emoji-batches';
const SNAPSHOT = 'catalog-snapshot-2026-10-30.json';
const BATCH_SIZE = 9;

export type Candidate = {
  category: string;
  name: string;
  nameEn: string;
  hint?: string;
  action: 'create' | 'update-image';
};

type Snapshot = {
  categories: { name: string; products: { name: string; nameEn: string }[] }[];
};

type CandidatesFile = {
  redo: Omit<Candidate, 'action'>[];
  categories: { category: string; products: Omit<Candidate, 'action' | 'category'>[] }[];
};

export function normalizeName(value: string) {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

export function collectCandidates(file: CandidatesFile, snapshot: Snapshot): Candidate[] {
  const categories = new Set(snapshot.categories.map((category) => category.name));
  const existing = new Set(
    snapshot.categories.flatMap((category) =>
      category.products.flatMap((product) => [
        normalizeName(product.name),
        normalizeName(product.nameEn),
      ])
    )
  );
  const seen = new Set<string>();
  const result: Candidate[] = [];

  const add = (candidate: Candidate) => {
    const key = normalizeName(candidate.name);
    if (!categories.has(candidate.category)) {
      throw new Error(`Unknown category "${candidate.category}" for "${candidate.name}"`);
    }
    if (seen.has(key)) throw new Error(`Duplicate candidate "${candidate.name}"`);
    const inCatalog = existing.has(key);
    if (
      candidate.action === 'create' &&
      (inCatalog || existing.has(normalizeName(candidate.nameEn)))
    ) {
      throw new Error(`"${candidate.name}" is already in the catalog`);
    }
    if (candidate.action === 'update-image' && !inCatalog) {
      throw new Error(`"${candidate.name}" is not in the catalog, nothing to update`);
    }
    seen.add(key);
    result.push(candidate);
  };

  for (const item of file.redo) add({ ...item, action: 'update-image' });
  for (const group of file.categories) {
    for (const item of group.products) add({ ...item, category: group.category, action: 'create' });
  }
  return result;
}

export function chunk<T>(items: T[], size = BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

export function batchId(index: number) {
  return `batch-${String(index + 1).padStart(3, '0')}`;
}

function describe(item: Candidate) {
  return item.hint ?? item.nameEn.toLowerCase();
}

export function geminiPrompt(items: Candidate[]) {
  const rows = chunk(items, 3).map(
    (row, r) =>
      `Row ${r + 1}: ` +
      row.map((item, c) => `${r * 3 + c + 1}) «${item.name}» — ${describe(item)}`).join('; ')
  );
  const count = items.length;
  const grid = count === BATCH_SIZE ? '3×3 grid' : `3-column grid, ${count} icons`;

  return `Create ONE square image: a ${grid} of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
${rows.join('\n')}`;
}

// Sent in the same chat right after the Russian sheet: Gemini edits its own picture, so the
// drawings stay the same and only the packaging text changes.
export function englishFollowUpPrompt(items: Candidate[]) {
  const names = items.map((item, i) => `${i + 1}) «${item.name}» → "${item.nameEn}"`).join('; ');
  return `Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: ${names}`;
}

function batchMarkdown(id: string, items: Candidate[]) {
  const table = items
    .map(
      (item, i) =>
        `| ${i + 1} | ${item.name} | ${item.nameEn} | ${item.category} | ${
          item.action === 'create' ? 'новый' : 'картинка для существующего'
        } |`
    )
    .join('\n');

  return `# ${id}

Новый чат в Gemini → вставить промпт → сохранить картинку как \`${id}.png\`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как \`${id}-en.png\`.

| Ячейка | Товар | English | Категория | Действие |
|---|---|---|---|---|
${table}

## Промпт

\`\`\`text
${geminiPrompt(items)}
\`\`\`

## Английская версия (только если есть надписи, в том же чате)

\`\`\`text
${englishFollowUpPrompt(items)}
\`\`\`
`;
}

function main() {
  const file = JSON.parse(readFileSync(join(DIR, 'candidates.json'), 'utf8')) as CandidatesFile;
  const snapshot = JSON.parse(readFileSync(join(DIR, SNAPSHOT), 'utf8')) as Snapshot;
  const batches = chunk(collectCandidates(file, snapshot));

  const batchDir = join(DIR, 'batches');
  rmSync(batchDir, { recursive: true, force: true });
  mkdirSync(batchDir, { recursive: true });

  const manifest = batches.map((items, index) => {
    const id = batchId(index);
    writeFileSync(join(batchDir, `${id}.md`), batchMarkdown(id, items));
    return {
      batch: id,
      file: `${id}.png`,
      fileEn: `${id}-en.png`,
      cells: items.map((item, i) => ({ cell: i + 1, ...item })),
    };
  });

  writeFileSync(join(DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.length} batches, ${manifest.flatMap((b) => b.cells).length} products`);
}

if (process.argv[1]?.endsWith('emoji-batches.ts')) main();
