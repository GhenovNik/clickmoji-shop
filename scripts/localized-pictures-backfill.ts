import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';
import {
  applyBackfill,
  formatCounts,
  planBackfill,
  sanitizeBackfillError,
  totalsOf,
  type BackfillPlan,
} from './lib/localized-pictures-backfill';

// Fills imageTextLocale and localizedImages on Product, ProductVariant and ListHistoryItem from the
// legacy imageUrl / imageUrlEn columns and the emoji library (AGE-1667). The legacy columns are
// not changed. Repeatable: a second run on unchanged data writes nothing.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/localized-pictures-backfill.ts          dry-run (default)
//   DATABASE_URL=... npx tsx scripts/localized-pictures-backfill.ts --apply  writes in one transaction
// DATABASE_URL is read from the inherited environment only, never from .env.
// The output contains counts only: no URLs, no row ids.

const USAGE = [
  'Usage: DATABASE_URL=... npx tsx scripts/localized-pictures-backfill.ts [--apply]',
  '',
  'Without --apply nothing is written; the output shows the projection.',
  '  --apply      Write inside one Serializable transaction, then verify by re-reading',
  '  -h, --help   Show this help message',
].join('\n');

const MODEL_LABEL = {
  product: 'Product',
  productVariant: 'ProductVariant',
  listHistoryItem: 'ListHistoryItem (product snapshot)',
} as const;

function printPlan(plan: BackfillPlan, mode: 'DRY-RUN' | 'APPLY', appliedWrites?: number) {
  console.log(`[${mode}] EmojiLibraryItem rows read: ${plan.libraryRows}`);
  for (const model of plan.models) {
    console.log(`${MODEL_LABEL[model.model]}`);
    console.log(`  before: ${formatCounts(model.before)}`);
    console.log(
      `  ${mode === 'APPLY' ? 'after (re-read)' : 'after (projected)'}: ${formatCounts(model.projectedAfter)}`
    );
    console.log(
      `  writes: ${model.writeCounts.rows} row(s) (text locale ${model.writeCounts.textLocale}, English copy ${model.writeCounts.english})`
    );
  }
  const totals = totalsOf(plan.models);
  console.log('Total');
  console.log(`  before: ${formatCounts(totals.before)}`);
  console.log(
    `  ${mode === 'APPLY' ? 'after (re-read)' : 'after (projected)'}: ${formatCounts(totals.after)}`
  );
  if (mode === 'APPLY') {
    console.log(
      `[APPLY] Applied ${appliedWrites ?? 0} row write(s); committed after verification.`
    );
  } else {
    console.log(
      `[DRY-RUN] Would write ${totals.writeCounts.rows} row(s). Nothing was written. Run with --apply to write.`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const unknown = args.filter((arg) => arg !== '--apply');
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown[0]}`);
  }
  const apply = args.includes('--apply');

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is not set in the environment');
  }

  const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
  try {
    if (apply) {
      const result = await applyBackfill(prisma);
      printPlan(result.plan, 'APPLY', result.appliedWrites);
    } else {
      const plan = await planBackfill(prisma);
      printPlan(plan, 'DRY-RUN');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`localized-pictures-backfill failed: ${sanitizeBackfillError(error)}`);
  process.exitCode = 1;
});
