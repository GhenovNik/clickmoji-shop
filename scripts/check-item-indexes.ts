import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';
import { itemIndexDrift, type ItemIndex } from '../src/lib/item-indexes';

// Read-only on purpose: detecting drift must never silently repair a database.
const db = new PrismaClient({ adapter: createPrismaPgAdapter() });
try {
  const indexes = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return tx.$queryRaw<ItemIndex[]>`
      SELECT c.relname AS name, i.indisunique AS "unique", i.indisprimary AS "primary",
             i.indisvalid AS valid, am.amname AS method,
             pg_get_expr(i.indpred, i.indrelid) AS predicate,
             ARRAY(SELECT COALESCE(a.attname::text, pg_get_indexdef(i.indexrelid, k.n::int, true))
                   FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
                   LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                   ORDER BY k.n) AS columns
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
      WHERE i.indrelid = to_regclass('public.items')
      ORDER BY c.relname`;
  });
  const problems = itemIndexDrift(indexes);
  if (problems.length) {
    console.error(`Item index drift detected:\n${problems.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('Item indexes match prisma/schema.prisma (only id is UNIQUE).');
  }
} catch {
  // Do not expose connection credentials via driver exceptions in CI/release logs.
  console.error('Could not inspect Item indexes; check database access and schema.');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
