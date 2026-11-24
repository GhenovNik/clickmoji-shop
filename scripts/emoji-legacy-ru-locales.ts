import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';
import {
  applyLegacyRussianLocales,
  assertApprovedLegacyRussianTargets,
  loadCanonicalLegacyRussianTargets,
  loadLegacyRussianTargets,
  parseCliArgs,
  planLegacyRussianLocales,
  sanitizeDatabaseErrorMessage,
  type LegacyRussianPlan,
} from '../src/lib/services/emoji-legacy-ru-locales';

// Sets locale="ru" (and aligns groupKey with any existing English twin) on the legacy batch-NNN
// library pictures marked as redrawn in text batches in
// docs/emoji-batches/manifest.json and candidates.json.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/emoji-legacy-ru-locales.ts [--manifest <path>] [--candidates <path>]
//   DATABASE_URL=... npx tsx scripts/emoji-legacy-ru-locales.ts --apply ...
//
// Without --apply nothing is written (dry-run).
// DATABASE_URL is read from the inherited environment only, never from .env.

const USAGE = [
  'Usage: DATABASE_URL=... npx tsx scripts/emoji-legacy-ru-locales.ts [options]',
  '',
  'Tag the 11 superseded legacy batch-NNN Russian library pictures with locale="ru"',
  '(and shared English twin groupKey when present).',
  '',
  'Options:',
  '  --apply              Apply updates inside a Serializable transaction (default: dry-run)',
  '  --manifest <path>    Override docs/emoji-batches/manifest.json',
  '  --candidates <path>  Override docs/emoji-batches/candidates.json',
  '  -h, --help           Show this help message',
  '',
  'Operational warning:',
  '  After applying Я1, do NOT reimport superseded legacy batches through',
  '  scripts/emoji-import.ts because emoji-import resets these tags (overwriting',
  '  superseded legacy rows back to locale=null and their original batch groupKey).',
].join('\n');

function printPlan(plan: LegacyRussianPlan, apply: boolean, appliedUpdates?: number) {
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`[${mode}] Legacy batch pictures selected: ${plan.items.length}`);
  console.log(`[${mode}] Library row count: ${plan.totalLibraryCount}`);

  for (const item of plan.items) {
    const pairNote = item.paired
      ? `paired(${item.enSourceRef ?? item.enId}, groupKey=${item.targetGroupKey})`
      : `unpaired(groupKey=${item.ruGroupKeyTo ?? 'null'})`;
    const localeChange =
      item.ruLocaleFrom === item.ruLocaleTo
        ? `locale=${item.ruLocaleTo}`
        : `locale:${item.ruLocaleFrom ?? 'null'}->${item.ruLocaleTo}`;
    const groupChange =
      item.ruGroupKeyFrom !== item.ruGroupKeyTo
        ? `, ru.groupKey:${item.ruGroupKeyFrom ?? 'null'}->${item.ruGroupKeyTo}`
        : '';
    const enGroupChange =
      item.paired && item.enGroupKeyFrom !== item.enGroupKeyTo
        ? `, en.groupKey:${item.enGroupKeyFrom ?? 'null'}->${item.enGroupKeyTo}`
        : '';
    const status = item.changed ? 'UPDATE' : 'UNCHANGED';
    console.log(
      `  ${item.ref} -> ${item.supersededBy} [${status}] ${localeChange}${groupChange}${enGroupChange} (${pairNote})`
    );
  }

  const changedItems = plan.items.filter((item) => item.changed).length;
  const unchangedItems = plan.items.length - changedItems;
  if (apply) {
    console.log(
      `[APPLY] Applied ${appliedUpdates ?? 0} row update(s) across ${changedItems} target(s); ${unchangedItems} unchanged.`
    );
  } else {
    console.log(
      `[DRY-RUN] Planned ${plan.operations.length} row update(s) across ${changedItems} target(s); ${unchangedItems} already up to date. Nothing was written.`
    );
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const canonicalTargets = loadCanonicalLegacyRussianTargets();
  const targets = loadLegacyRussianTargets({
    manifestPath: options.manifestPath,
    candidatesPath: options.candidatesPath,
  });
  assertApprovedLegacyRussianTargets(targets, canonicalTargets);

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is not set in the environment');
  }

  const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
  try {
    if (options.apply) {
      const result = await applyLegacyRussianLocales(prisma, targets);
      printPlan(result.plan, true, result.appliedUpdates);
      console.log(`[APPLY] Library row count after: ${result.totalLibraryCountAfter}`);
    } else {
      const plan = await planLegacyRussianLocales(prisma, targets);
      printPlan(plan, false);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const rawMessage = error instanceof Error ? error.message : String(error);
  console.error(`emoji-legacy-ru-locales failed: ${sanitizeDatabaseErrorMessage(rawMessage)}`);
  process.exitCode = 1;
});
