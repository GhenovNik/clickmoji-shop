import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';
import { applyCatalogCleanup, CATALOG_CLEANUP_PLAN } from '../src/lib/services/catalog-cleanup';

// Merges duplicate products, turns a few products into variants, moves misfiled products and
// fixes English typos (src/lib/services/catalog-cleanup.ts). Without --apply everything runs in a
// transaction that is rolled back, so the report shows exactly what --apply would do. Take a
// backup first (npm run db:backup): merged products are deleted.
// Deploy migrations first. The helper locks catalogue/reference tables for the entire transaction
// (dry runs too); normal reads continue, writes wait or fail their lock timeout. Stale post-cleanup
// references fail their FK, including history, whose snapshot fields are never deleted.

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
const apply = process.argv.includes('--apply');

class DryRun extends Error {}

async function main() {
  console.log(apply ? 'Applying catalogue cleanup\n' : 'Dry run (rolled back), use --apply\n');
  try {
    await prisma.$transaction(
      async (tx) => {
        await applyCatalogCleanup(tx, CATALOG_CLEANUP_PLAN, (line) => console.log(`  ${line}`));
        if (!apply) throw new DryRun();
      },
      { timeout: 60_000, isolationLevel: 'ReadCommitted' }
    );
    console.log('\nDone.');
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    console.log('\nNothing was written.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
