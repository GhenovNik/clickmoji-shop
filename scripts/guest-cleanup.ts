import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';
import { cleanupInactiveGuests, resolveGuestInactiveDays } from '../src/lib/guest-cleanup';

// Deletes server-backed guest accounts inactive for at least `--inactive-days` (or
// GUEST_CLEANUP_INACTIVE_DAYS, default 30). Callable on demand or by an external scheduler.
// Pass `--dry-run` to report eligible guest counts without deleting anything.

function parseArgs(argv: string[]): { inactiveDays: number; dryRun: boolean } {
  let rawDays: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--inactive-days') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --inactive-days');
      }
      rawDays = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--inactive-days=')) {
      rawDays = arg.slice('--inactive-days='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    inactiveDays: resolveGuestInactiveDays(rawDays),
    dryRun,
  };
}

async function main() {
  const { inactiveDays, dryRun } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

  try {
    const result = await cleanupInactiveGuests({
      db: prisma,
      inactiveDays,
      dryRun,
    });

    console.log(
      JSON.stringify({
        action: 'guest-cleanup',
        dryRun: result.dryRun,
        inactiveDays: result.inactiveDays,
        cutoff: result.cutoff.toISOString(),
        matchedCount: result.matchedCount,
        deletedCount: result.deletedCount,
      })
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Guest cleanup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
