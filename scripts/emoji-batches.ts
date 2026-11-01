import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Builds the emoji batches for the operator (AGE-1465 item 1): docs/emoji-batches/candidates.json
// minus the catalog snapshot → batches of 9 with a ready Gemini prompt and a cell manifest.
// Usage: npx tsx scripts/emoji-batches.ts

const DIR = 'docs/emoji-batches';
const SNAPSHOT = 'catalog-snapshot-2026-10-30.json';
const BATCH_SIZE = 9;
// Batches 001-008 were generated before text batches existed: their composition is frozen, and
// their cells with a label are drawn again in text batches.
const GENERATED_BATCHES = 8;

export type Candidate = {
  category: string;
  name: string;
  nameEn: string;
  hint?: string;
  // Shown with a label on the packaging: drawn once in Russian and once in English.
  text?: boolean;
  // Enclosed white regions of the picture were checked to be gaps (herb stems, a bunch, a donut
  // hole): the import may clear them. Never set on labelled products.
  gaps?: boolean;
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

export function batchId(index: number, kind: BatchKind = 'universal') {
  return `${kind === 'text' ? 'text' : 'batch'}-${String(index + 1).padStart(3, '0')}`;
}

export type BatchKind = 'universal' | 'text';

export type PlannedBatch = {
  id: string;
  kind: BatchKind;
  items: Candidate[];
  // Cells of a frozen batch whose picture is replaced by a text batch: "text-001#3".
  supersededBy?: Map<number, string>;
};

// Frozen batches first (as generated), then text-free batches, then text batches. A labelled
// product of a frozen batch moves to the text batches, and its old cell points at the new one.
export function planBatches(candidates: Candidate[], frozenBatches = GENERATED_BATCHES) {
  const frozen = chunk(candidates.slice(0, frozenBatches * BATCH_SIZE));
  const rest = candidates.slice(frozenBatches * BATCH_SIZE);
  const textItems = [
    ...frozen.flat().filter((item) => item.text),
    ...rest.filter((item) => item.text),
  ];
  const textBatches = chunk(textItems).map((items, index): PlannedBatch => ({
    id: batchId(index, 'text'),
    kind: 'text',
    items,
  }));

  const textCell = new Map<string, string>();
  for (const batch of textBatches) {
    batch.items.forEach((item, i) => textCell.set(item.name, `${batch.id}#${i + 1}`));
  }

  const frozenBatchesPlanned = frozen.map((items, index): PlannedBatch => {
    const supersededBy = new Map<number, string>();
    items.forEach((item, i) => {
      const ref = textCell.get(item.name);
      if (ref) supersededBy.set(i + 1, ref);
    });
    return { id: batchId(index), kind: 'universal', items, supersededBy };
  });
  const universal = chunk(rest.filter((item) => !item.text)).map((items, index): PlannedBatch => ({
    id: batchId(frozen.length + index),
    kind: 'universal',
    items,
  }));

  return [...frozenBatchesPlanned, ...universal, ...textBatches];
}

function describe(item: Candidate) {
  return item.hint ?? item.nameEn.toLowerCase();
}

function cells(items: Candidate[], label: (item: Candidate) => string) {
  return chunk(items, 3)
    .map(
      (row, r) =>
        `Row ${r + 1}: ` +
        row.map((item, c) => `${r * 3 + c + 1}) ${label(item)} — ${describe(item)}`).join('; ')
    )
    .join('\n');
}

function gridOf(items: Candidate[]) {
  return items.length === BATCH_SIZE ? '3×3 grid' : `3-column grid, ${items.length} icons`;
}

const STYLE = `Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.`;

// A text-free picture serves every language.
export function universalPrompt(items: Candidate[]) {
  return `Create ONE square image: a ${gridOf(items)} of separate product emoji on a pure white background (#FFFFFF).

${STYLE}
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
${cells(items, (item) => `«${item.name}»`)}`;
}

export function textPrompt(items: Candidate[]) {
  return `Create ONE square image: a ${gridOf(items)} of separate product emoji on a pure white background (#FFFFFF).

${STYLE}
Each product is shown in its typical packaging with ONE short label in Russian, exactly the quoted word(s) below, large, spelled correctly. No other text, no brand names.

Cells, left to right, top to bottom (label in quotes):
${cells(items, (item) => `label «${item.name}»`)}`;
}

// Sent in the same chat right after the Russian sheet: Gemini edits its own picture, so the
// drawings stay the same and only the labels change.
export function englishFollowUpPrompt(items: Candidate[]) {
  const names = items.map((item, i) => `${i + 1}) «${item.name}» → "${item.nameEn}"`).join('; ');
  return `Make exactly the same image: the same drawings, layout, colours and white background. Replace ONLY the label text with English, exactly as listed. Do not add any other text.
${names}`;
}

const ACTION = { create: 'новый', 'update-image': 'картинка для существующего' } as const;

function table(items: Candidate[], supersededBy?: Map<number, string>) {
  const rows = items.map((item, i) => {
    const moved = supersededBy?.get(i + 1);
    const action = moved ? `перерисовывается в ${moved.split('#')[0]}` : ACTION[item.action];
    return `| ${i + 1} | ${item.name} | ${item.nameEn} | ${item.category} | ${action} |`;
  });
  return `| Ячейка | Товар | English | Категория | Действие |
|---|---|---|---|---|
${rows.join('\n')}`;
}

function batchMarkdown(batch: PlannedBatch) {
  const { id, kind, items, supersededBy } = batch;
  if (kind === 'text') {
    return `# ${id} — с надписями (две версии)

1. **Новый чат** в Gemini → промпт «Русская версия» → сохранить как \`${id}.png\`.
2. **В том же чате** → промпт «Английская версия» → сохранить как \`${id}-en.png\`.
   Рисунки остаются те же, меняются только надписи.

${table(items)}

## Русская версия

\`\`\`text
${textPrompt(items)}
\`\`\`

## Английская версия (в том же чате)

\`\`\`text
${englishFollowUpPrompt(items)}
\`\`\`
`;
  }

  const frozen = supersededBy !== undefined;
  return `# ${id} — без надписей (одна версия на оба языка)

${frozen ? 'Уже сгенерирована. Ячейки с надписями перерисовываются в текстовых пачках: здесь их картинка остаётся только в библиотеке.' : `Новый чат в Gemini → вставить промпт → сохранить картинку как \`${id}.png\`.`}

${table(items, supersededBy)}

## Промпт

\`\`\`text
${universalPrompt(items)}
\`\`\`
`;
}

function main() {
  const file = JSON.parse(readFileSync(join(DIR, 'candidates.json'), 'utf8')) as CandidatesFile;
  const snapshot = JSON.parse(readFileSync(join(DIR, SNAPSHOT), 'utf8')) as Snapshot;
  const batches = planBatches(collectCandidates(file, snapshot));

  const batchDir = join(DIR, 'batches');
  rmSync(batchDir, { recursive: true, force: true });
  mkdirSync(batchDir, { recursive: true });

  const manifest = batches.map((batch) => {
    writeFileSync(join(batchDir, `${batch.id}.md`), batchMarkdown(batch));
    return {
      batch: batch.id,
      kind: batch.kind,
      file: `${batch.id}.png`,
      ...(batch.kind === 'text' && { fileEn: `${batch.id}-en.png` }),
      cells: batch.items.map((item, i) => {
        const supersededBy = batch.supersededBy?.get(i + 1);
        return { cell: i + 1, ...item, ...(supersededBy && { supersededBy }) };
      }),
    };
  });

  writeFileSync(join(DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const count = (kind: BatchKind) => manifest.filter((b) => b.kind === kind).length;
  console.log(
    `${count('universal')} text-free batches, ${count('text')} text batches, ${
      new Set(manifest.flatMap((b) => b.cells.map((c) => c.name))).size
    } products`
  );
}

if (process.argv[1]?.endsWith('emoji-batches.ts')) main();
