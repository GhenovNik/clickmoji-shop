import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import {
  CATEGORY_RULE_EXACTLY_THREE,
  chunk,
  englishFollowUpPrompt,
  normalizeName,
  textPrompt,
  universalPrompt,
  type Candidate,
} from './emoji-batches';

// Builds the queue for the 144 catalogue targets (AGE-1667 C6): 123 products and 2 product variants
// that have no picture yet, all 19 categories, and the 5 categories that already have one, which
// are replaced (action "replace"). Everything is taken from the catalogue snapshot.
// Input: docs/emoji-batches/queue-candidates.json, checked against the snapshot. Output:
// docs/emoji-batches/queue/*.md (prompts) and docs/emoji-batches/queue-manifest.json (cells).
// Usage: npx tsx scripts/emoji-queue.ts

const DIR = 'docs/emoji-batches';
const SNAPSHOT = 'catalog-snapshot-2026-11-25.json';
const CANDIDATES = 'queue-candidates.json';
const BATCH_SIZE = 9;

export type QueueTarget = 'product' | 'variant' | 'category';

export type QueueItem = {
  target: QueueTarget;
  // The catalogue category of a product or variant; a category target repeats its own name.
  category: string;
  name: string;
  nameEn: string;
  // Variant only: the name of its product.
  parent?: string;
  hint?: string;
  // Packaging with a label: drawn in a text batch, once in Russian and once in English.
  text?: boolean;
  // update-image: the record has no picture and gets one. replace: the record has a picture that
  // the import swaps for this one, only when the operator authorises the old URL (categories only).
  action: 'update-image' | 'replace';
};

type Snapshot = {
  categories: {
    name: string;
    nameEn: string;
    hasImage: boolean;
    products: {
      name: string;
      nameEn: string;
      hasImage: boolean;
      variants?: { name: string; nameEn: string; hasImage: boolean }[];
    }[];
  }[];
};

export type PlannedQueueBatch = {
  id: string;
  kind: 'universal' | 'text';
  items: QueueItem[];
};

// Every catalogue target in snapshot order: a product, then its variants, then the categories.
// Products and variants without a picture are update-image; so are categories without one. A
// category that already has a picture is the only record with action replace.
export function catalogueTargets(snapshot: Snapshot): QueueItem[] {
  const items: QueueItem[] = [];
  for (const category of snapshot.categories) {
    for (const product of category.products) {
      if (!product.hasImage) {
        items.push({
          target: 'product',
          category: category.name,
          name: product.name,
          nameEn: product.nameEn,
          action: 'update-image',
        });
      }
      for (const variant of product.variants ?? []) {
        if (!variant.hasImage) {
          items.push({
            target: 'variant',
            category: category.name,
            parent: product.name,
            name: variant.name,
            nameEn: variant.nameEn,
            action: 'update-image',
          });
        }
      }
    }
  }
  for (const category of snapshot.categories) {
    items.push({
      target: 'category',
      category: category.name,
      name: category.name,
      nameEn: category.nameEn,
      action: category.hasImage ? 'replace' : 'update-image',
    });
  }
  return items;
}

function targetKey(item: Pick<QueueItem, 'target' | 'category' | 'name' | 'parent'>) {
  return [
    item.target,
    normalizeName(item.category),
    normalizeName(item.parent ?? ''),
    normalizeName(item.name),
  ].join('|');
}

// The queue must match the snapshot exactly: every catalogue target once, nothing else, the fields
// that locate each record agree with the snapshot, and the action agrees with the picture the
// snapshot shows (replace exactly for the categories that have one).
export function validateQueue(items: QueueItem[], snapshot: Snapshot) {
  const problems: string[] = [];
  const expected = catalogueTargets(snapshot);
  const expectedByKey = new Map(expected.map((item) => [targetKey(item), item]));
  const seen = new Set<string>();

  for (const item of items) {
    const key = targetKey(item);
    if (seen.has(key)) problems.push(`duplicate: ${item.target} «${item.name}»`);
    seen.add(key);
    const match = expectedByKey.get(key);
    if (!match) {
      problems.push(`not a catalogue target: ${item.target} «${item.name}»`);
      continue;
    }
    if (match.nameEn !== item.nameEn) {
      problems.push(`nameEn differs from the snapshot: «${item.name}» → «${match.nameEn}»`);
    }
    if (item.action !== match.action) {
      problems.push(
        `action differs from the snapshot: ${item.target} «${item.name}» is ${match.action}, not ${item.action}`
      );
    }
    if (item.target === 'category' && item.text) {
      problems.push(`category «${item.name}» cannot carry text`);
    }
    if (item.target === 'category' && !item.hint?.startsWith('exactly three ')) {
      problems.push(`category «${item.name}» must ask for exactly three items`);
    }
  }
  for (const item of expected) {
    if (!seen.has(targetKey(item))) problems.push(`missing: ${item.target} «${item.name}»`);
  }
  if (problems.length)
    throw new Error(`Queue does not match the snapshot:\n${problems.join('\n')}`);
}

function batchNumber(index: number) {
  return String(index + 1).padStart(3, '0');
}

// Text-free records fill the universal batches in order; labelled products fill the text batches.
export function planQueueBatches(items: QueueItem[]): PlannedQueueBatch[] {
  const universal = items.filter((item) => !item.text);
  const labelled = items.filter((item) => item.text);
  return [
    ...chunk(universal, BATCH_SIZE).map((batch, i): PlannedQueueBatch => ({
      id: `queue-${batchNumber(i)}`,
      kind: 'universal',
      items: batch,
    })),
    ...chunk(labelled, BATCH_SIZE).map((batch, i): PlannedQueueBatch => ({
      id: `queue-text-${batchNumber(i)}`,
      kind: 'text',
      items: batch,
    })),
  ];
}

const KIND_LABEL: Record<QueueTarget, string> = {
  product: 'товар',
  variant: 'вариант',
  category: 'категория',
};

// One cell per target. A category cell shows exactly three items of its group (CATEGORY_RULE_EXACTLY_THREE).
function asCandidate(item: QueueItem): Candidate {
  return {
    category: item.category,
    name: item.name,
    nameEn: item.nameEn,
    hint: item.hint,
    text: item.text,
    action: item.action,
  };
}

const ACTION_LABEL: Record<QueueItem['action'], string> = {
  'update-image': 'новая картинка',
  replace: 'замена картинки (старый URL в --replace-auth)',
};

function table(items: QueueItem[]) {
  const rows = items.map(
    (item, i) =>
      `| ${i + 1} | ${item.name} | ${item.nameEn} | ${item.category} | ${KIND_LABEL[item.target]}${
        item.parent ? ` (${item.parent})` : ''
      } | ${ACTION_LABEL[item.action]} |`
  );
  return `| Ячейка | Цель | English | Каталог | Тип | Действие |
|---|---|---|---|---|---|
${rows.join('\n')}`;
}

const SAMPLES =
  'Приложить все четыре образца из `docs/emoji-batches/style-refs/` (`zucchini.webp`, `lentils.webp`, `honey.webp`, `kefir.webp`)';

export function queueMarkdown(batch: PlannedQueueBatch) {
  const { id, kind, items } = batch;
  const candidates = items.map(asCandidate);
  if (kind === 'text') {
    return `# ${id} — с надписями (две версии)

1. **Новый чат** в Gemini. ${SAMPLES}. Вставить промпт «Русская версия» и сохранить как \`${id}.png\`.
2. **В том же чате** → промпт «Английская версия» → сохранить как \`${id}-en.png\`.
   Рисунки остаются те же, меняются только надписи.

${table(items)}

## Русская версия

\`\`\`text
${textPrompt(candidates, CATEGORY_RULE_EXACTLY_THREE)}
\`\`\`

## Английская версия (в том же чате)

\`\`\`text
${englishFollowUpPrompt(candidates)}
\`\`\`
`;
  }

  return `# ${id} — без надписей (одна версия на оба языка)

Новый чат в Gemini. ${SAMPLES}. Вставить промпт и сохранить картинку как \`${id}.png\`.

${table(items)}

## Промпт

\`\`\`text
${universalPrompt(candidates, CATEGORY_RULE_EXACTLY_THREE)}
\`\`\`
`;
}

function manifestEntry(batch: PlannedQueueBatch) {
  return {
    batch: batch.id,
    kind: batch.kind,
    file: `${batch.id}.png`,
    ...(batch.kind === 'text' && { fileEn: `${batch.id}-en.png` }),
    cells: batch.items.map((item, i) => ({
      cell: i + 1,
      target: item.target,
      category: item.category,
      name: item.name,
      nameEn: item.nameEn,
      ...(item.parent && { parent: item.parent }),
      ...(item.hint && { hint: item.hint }),
      ...(item.text && { text: true }),
      action: item.action,
    })),
  };
}

export async function main(dir = DIR, formatMarkdown = format) {
  const file = JSON.parse(readFileSync(join(dir, CANDIDATES), 'utf8')) as { items: QueueItem[] };
  const snapshot = JSON.parse(readFileSync(join(dir, SNAPSHOT), 'utf8')) as Snapshot;
  validateQueue(file.items, snapshot);
  const batches = planQueueBatches(file.items);

  const queueDir = join(dir, 'queue');
  const prettierOptions = await resolveConfig(join(queueDir, 'queue.md'));
  // Everything is formatted before anything is written, so a failure keeps the old files.
  const prepared = await Promise.all(
    batches.map(async (batch) => ({
      id: batch.id,
      markdown: await formatMarkdown(queueMarkdown(batch), {
        ...prettierOptions,
        parser: 'markdown',
      }),
      entry: manifestEntry(batch),
    }))
  );

  rmSync(queueDir, { recursive: true, force: true });
  mkdirSync(queueDir, { recursive: true });
  for (const { id, markdown } of prepared) {
    writeFileSync(join(queueDir, `${id}.md`), markdown);
  }
  writeFileSync(
    join(dir, 'queue-manifest.json'),
    `${JSON.stringify(
      prepared.map(({ entry }) => entry),
      null,
      2
    )}\n`
  );
  const universal = batches.filter((b) => b.kind === 'universal').length;
  const replace = file.items.filter((item) => item.action === 'replace').length;
  console.log(
    `${file.items.length} targets (${replace} replace) in ${universal} text-free and ${batches.length - universal} text batches`
  );
}

if (process.argv[1]?.endsWith('emoji-queue.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
