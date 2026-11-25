import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';
import {
  auditCatalogPrimaryImages,
  formatAuditReportLines,
  parseAuditCliArgs,
} from '../src/lib/services/catalog-image-audit';
import { SafeOperationalError, safeErrorTag } from '../src/lib/services/catalog-image-http';

// Audits all primary catalog image URLs (`imageUrl`) via read-only PostgreSQL access and HTTP 200
// checks. Outputs only item names, HTTP/safe statuses, and aggregate counts.
// DATABASE_URL is read strictly from process.env (never from .env).

const USAGE = [
  'Usage: DATABASE_URL=... npx tsx scripts/audit-catalog-images.ts [options]',
  '',
  'Check HTTP 200 status for every primary catalog imageUrl (categories, global products, variants).',
  '',
  'Options:',
  '  --failures-only   Print only non-200 / missing / invalid / error entries before summary',
  '  -h, --help        Show this help message',
].join('\n');

async function main() {
  const options = parseAuditCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  if (!process.env.DATABASE_URL?.trim()) {
    throw new SafeOperationalError(
      'MISSING_DATABASE_URL',
      'DATABASE_URL is not set in the environment'
    );
  }

  const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
  try {
    const report = await auditCatalogPrimaryImages(prisma);
    for (const line of formatAuditReportLines(report, { failuresOnly: options.failuresOnly })) {
      console.log(line);
    }
    process.exitCode = report.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const tag = safeErrorTag(error);
  console.error(`catalog-image-audit failed: ${tag}`);
  process.exitCode = 1;
});
