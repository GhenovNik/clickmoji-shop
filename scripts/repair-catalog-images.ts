import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';
import { SafeOperationalError, safeErrorTag } from '../src/lib/services/catalog-image-http';
import {
  applyCatalogImageRepairs,
  dryRunCatalogImageRepairs,
  parseRepairCliArgs,
  parseRepairPlan,
} from '../src/lib/services/catalog-image-repair';

// Safely repairs primary catalog image URLs (`imageUrl`, `isCustom`) for proven `(old -> new)`
// pairs. Dry-run by default; requires explicit `--apply` to write inside a Serializable
// transaction with conditional row updates (zero partial apply and no overwriting concurrent edits).
// DATABASE_URL is read strictly from process.env (never from .env).

const USAGE = [
  'Usage: DATABASE_URL=... npx tsx scripts/repair-catalog-images.ts --plan <path.json> [--apply]',
  '',
  'Verify and atomically repair primary catalog image fields for proven old -> new pairs.',
  '',
  'Options:',
  '  --plan <path>   Path to JSON file { "repairs": [...] } (required)',
  '  --apply         Apply updates inside one Serializable transaction (default: dry-run)',
  '  -h, --help      Show this help message',
].join('\n');

async function main() {
  const options = parseRepairCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  if (!options.planPath) {
    throw new SafeOperationalError('MISSING_PLAN', 'Option --plan <path> is required');
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(readFileSync(resolve(options.planPath), 'utf8')) as unknown;
  } catch {
    throw new SafeOperationalError('UNREADABLE_PLAN', 'Failed to read or parse --plan JSON file');
  }

  const entries = parseRepairPlan(rawJson);

  if (!process.env.DATABASE_URL?.trim()) {
    throw new SafeOperationalError(
      'MISSING_DATABASE_URL',
      'DATABASE_URL is not set in the environment'
    );
  }

  const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
  try {
    const result = options.apply
      ? await applyCatalogImageRepairs(prisma, entries)
      : await dryRunCatalogImageRepairs(prisma, entries);

    const tag = result.mode === 'apply' ? 'APPLY' : 'DRY-RUN';
    for (const decision of result.decisions) {
      console.log(`[${tag}] ${decision.targetLabel}: ${decision.status} (${decision.detail})`);
    }
    console.log(
      `[${tag}] planned=${result.plannedCount}, updated=${result.updatedCount}, exit=${result.exitCode}`
    );
    process.exitCode = result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const tag = safeErrorTag(error);
  const message =
    error instanceof SafeOperationalError ? error.message : 'Unexpected failure during repair';
  console.error(`repair-catalog-images failed [${tag}]: ${message}`);
  process.exitCode = 1;
});
