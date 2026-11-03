import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-adapter';

// Only our named Docker and a freshly owned database. Never modify the restored
// public schema or production to exercise DDL/locks and failed migration recovery.
const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
assert(
  ['localhost', '127.0.0.1'].includes(target.hostname) && (target.port || '5432') === '5432',
  'Local PostgreSQL required'
);
assert.equal(
  execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'clickmoji-local-pg'], {
    encoding: 'utf8',
  }).trim(),
  'true'
);
const name = `age1536_repair_${randomUUID().replaceAll('-', '')}`;
const admin = (sql: string) =>
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'clickmoji-local-pg',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql, encoding: 'utf8' }
  );
const source = new PrismaClient({ adapter: createPrismaPgAdapter() });
const [{ role }] = await source.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
await source.$disconnect();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
admin(`CREATE DATABASE ${quote(name)} OWNER ${quote(role)};`);
target.pathname = `/${name}`;
target.search = '';
const env = { ...process.env, DATABASE_URL: target.toString() };
const db = new PrismaClient({ adapter: createPrismaPgAdapter(target.toString()) });
const scratch = mkdtempSync(join(tmpdir(), 'age1536-repair-'));
const migrationName = '20261102224241_drop_legacy_item_variant_unique';
const baseline = process.argv.includes('--baseline');
const oldHead = 'aae343d79bea0ac86b5072aef02255b4332b7378';
const fromGit = (path: string) =>
  execFileSync('git', ['show', `${oldHead}:${path}`], { encoding: 'utf8' });
const repairPath = `prisma/migrations/${migrationName}/migration.sql`;
const repair = baseline ? fromGit(repairPath) : readFileSync(repairPath, 'utf8');
let scanPath = 'scripts/check-item-indexes.ts';
if (baseline) {
  const mirror = join(scratch, 'baseline');
  mkdirSync(join(mirror, 'scripts'), { recursive: true });
  mkdirSync(join(mirror, 'src', 'lib'), { recursive: true });
  writeFileSync(join(mirror, 'package.json'), '{"type":"module"}');
  symlinkSync(resolve('node_modules'), join(mirror, 'node_modules'));
  for (const file of [
    'scripts/check-item-indexes.ts',
    'src/lib/item-indexes.ts',
    'src/lib/prisma-adapter.ts',
  ]) {
    writeFileSync(join(mirror, file), fromGit(file));
  }
  scanPath = join(mirror, scanPath);
  console.log(`Testing exact baseline migration/checker source ${oldHead}`);
}
const config = join(scratch, 'prisma.config.mjs');
writeFileSync(
  config,
  `import {defineConfig} from ${JSON.stringify(pathToFileURL(resolve('node_modules/prisma/config.js')).href)}; export default defineConfig({schema:'schema.prisma', migrations:{path:'migrations'}, datasource:{url:process.env.DATABASE_URL}});`
);
writeFileSync(
  join(scratch, 'schema.prisma'),
  'datasource db {\n provider = "postgresql"\n}\nmodel Item {\n id String @id\n listId String\n productId String\n variantId String?\n @@index([listId])\n @@index([productId])\n @@map("items")\n}\n'
);
mkdirSync(join(scratch, 'migrations'));
writeFileSync(join(scratch, 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
function migration(folder: string, sql: string) {
  mkdirSync(join(scratch, 'migrations', folder));
  writeFileSync(join(scratch, 'migrations', folder, 'migration.sql'), sql);
}
const initSql =
  'CREATE TABLE items (id TEXT PRIMARY KEY, "listId" TEXT NOT NULL, "productId" TEXT NOT NULL, "variantId" TEXT); CREATE INDEX "items_listId_idx" ON items ("listId"); CREATE INDEX "items_productId_idx" ON items ("productId"); CREATE TABLE execution_probe (txid BIGINT DEFAULT txid_current()); CREATE TABLE initial_policy AS SELECT current_setting(\'lock_timeout\') AS lock_wait, current_setting(\'statement_timeout\') AS statement_wait;';
migration('000001_init', initSql);
// A single-statement CONCURRENTLY migration fails if Prisma wraps files in BEGIN.
migration(
  '000002_transaction_probe',
  'CREATE INDEX CONCURRENTLY prisma_transaction_probe_idx ON items ("variantId");'
);
migration(
  '000003_multi_statement_probe',
  'INSERT INTO execution_probe DEFAULT VALUES; INSERT INTO execution_probe DEFAULT VALUES;'
);

async function command(args: string[], bounded = false, executable = process.execPath) {
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  let cancelled = false;
  const started = performance.now();
  let lockStarted: number | undefined;
  let watching = false;
  // Count the lock wait, not Prisma CLI startup time. An 8s control deadline
  // cancels only an actually observed blocked DROP in this owned database.
  const monitor = bounded
    ? setInterval(() => {
        if (watching) return;
        watching = true;
        void (async () => {
          const blocked = await db.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_backend_pid()
          AND query LIKE '%DROP INDEX%' AND wait_event_type = 'Lock'`;
          if (blocked.length && lockStarted === undefined) lockStarted = performance.now();
          if (
            blocked.length &&
            lockStarted !== undefined &&
            performance.now() - lockStarted > 8_000
          ) {
            cancelled = true;
            for (const { pid } of blocked) await db.$queryRaw`SELECT pg_cancel_backend(${pid})`;
          }
        })()
          .catch(() => child.kill('SIGTERM'))
          .finally(() => {
            watching = false;
          });
      }, 100)
    : undefined;
  const timer = bounded
    ? setTimeout(() => {
        cancelled = true;
        child.kill('SIGTERM');
      }, 30_000)
    : undefined;
  const code = await new Promise<number>((done, reject) => {
    child.on('error', reject);
    child.on('close', (status) => done(status ?? 1));
  });
  clearTimeout(timer);
  clearInterval(monitor);
  return {
    code,
    output,
    cancelled,
    elapsedMs: Math.round(performance.now() - started),
    lockWaitMs: lockStarted === undefined ? null : Math.round(performance.now() - lockStarted),
  };
}
const prisma = (args: string[], bounded = false) =>
  command(['node_modules/prisma/build/index.js', ...args, '--config', config], bounded);
const scan = () => command(['--import', 'tsx', scanPath]);
try {
  const init = await prisma(['migrate', 'deploy']);
  assert.equal(init.code, 0, init.output);
  console.log(
    'Prisma transaction probe: CONCURRENTLY-only file succeeded; no engine-added explicit BEGIN/COMMIT.'
  );
  const transactions = await db.$queryRaw<{ txid: bigint }[]>`SELECT txid FROM execution_probe`;
  assert.equal(transactions.length, 2);
  assert.notEqual(
    transactions[0].txid,
    transactions[1].txid,
    'Installed Prisma engine executes each statement without a shared transaction'
  );
  console.log(
    'Multi-statement migration probe: writes have different transaction IDs (statement-by-statement, no file-wide transaction).'
  );
  await db.$executeRawUnsafe('DROP INDEX prisma_transaction_probe_idx');

  if (!process.argv.includes('--drift-only')) {
    await db.$executeRawUnsafe(
      'CREATE UNIQUE INDEX "items_listId_productId_variantId_key" ON items ("listId", "productId", "variantId")'
    );
    migration(migrationName, repair);
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((done) => {
      acquired = done;
    });
    const released = new Promise<void>((done) => {
      release = done;
    });
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE items IN ACCESS SHARE MODE');
        acquired();
        await released;
      },
      { timeout: 40_000 }
    );
    await ready;
    try {
      const blocked = await prisma(['migrate', 'deploy'], true);
      console.log(
        JSON.stringify({
          case: 'blocked repair',
          exit: blocked.code,
          cancelledByHarness: blocked.cancelled,
          elapsedMs: blocked.elapsedMs,
          lockWaitMs: blocked.lockWaitMs,
          lockTimeout55P03: /55P03/.test(blocked.output),
        })
      );
      assert.notEqual(blocked.code, 0, 'A blocked repair must fail');
      assert.equal(
        blocked.cancelled,
        false,
        'Repair exceeded 8 seconds and needed harness cancellation (unbounded lock wait)'
      );
      assert.match(
        blocked.output,
        /55P03/,
        'Expected PostgreSQL lock_timeout, not statement cancellation'
      );
      const [index] = await db.$queryRaw<
        { present: boolean }[]
      >`SELECT to_regclass('public."items_listId_productId_variantId_key"') IS NOT NULL AS present`;
      assert.equal(index.present, true, 'Timed-out repair must preserve the index');
    } finally {
      release();
      await blocker;
    }
    // Prisma records failed migrations. Retrying deploy alone is not recovery.
    migration(
      '20261102224242_verify_policy',
      "DO $$ BEGIN IF EXISTS(SELECT 1 FROM initial_policy WHERE lock_wait <> current_setting('lock_timeout') OR statement_wait <> current_setting('statement_timeout')) THEN RAISE EXCEPTION 'Repair leaked timeout settings into the next migration'; END IF; END $$;"
    );
    const resolved = await prisma(['migrate', 'resolve', '--rolled-back', migrationName]);
    assert.equal(resolved.code, 0, resolved.output);
    const retried = await prisma(['migrate', 'deploy']);
    assert.equal(retried.code, 0, retried.output);
    const [index] = await db.$queryRaw<
      { absent: boolean }[]
    >`SELECT to_regclass('public."items_listId_productId_variantId_key"') IS NULL AS absent`;
    assert.equal(index.absent, true);
    for (let i = 0; i < 2; i++) {
      const replay = await prisma([
        'db',
        'execute',
        '--file',
        join(scratch, 'migrations', migrationName, 'migration.sql'),
      ]);
      assert.equal(replay.code, 0, replay.output);
    }
    console.log(
      'Lock release → resolve --rolled-back → deploy PASS; index absent; next migration verified reset timeout policy; exact SQL replayed twice PASS.'
    );
  }

  assert.equal((await scan()).code, 0, 'Expected clean Item indexes before drift probes');
  for (const [label, key] of [
    ['partial', 'USING btree ("productId") WHERE "variantId" IS NOT NULL'],
    ['hash method', 'USING hash ("productId")'],
    ['sort direction', 'USING btree ("productId" DESC)'],
    ['null ordering', 'USING btree ("productId" NULLS FIRST)'],
    ['operator class', 'USING btree ("productId" text_pattern_ops)'],
    ['collation', 'USING btree ("productId" COLLATE "C")'],
    ['included columns', 'USING btree ("productId") INCLUDE ("listId")'],
  ]) {
    try {
      await db.$executeRawUnsafe('DROP INDEX "items_productId_idx"');
      await db.$executeRawUnsafe(`CREATE INDEX "items_productId_idx" ON items ${key}`);
      const result = await scan();
      console.log(JSON.stringify({ case: `catalog drift: ${label}`, exit: result.code }));
      assert.equal(result.code, 1, `Drift checker missed ${label}`);
      assert.match(result.output, /definition differs/);
    } finally {
      await db.$executeRawUnsafe('DROP INDEX IF EXISTS "items_productId_idx"');
      await db.$executeRawUnsafe('CREATE INDEX "items_productId_idx" ON items ("productId")');
    }
  }
  assert.equal((await scan()).code, 0, 'Expected clean indexes after probes');
  console.log('PostgreSQL migration/definition regression PASS.');
} finally {
  await db.$disconnect();
  admin(`DROP DATABASE ${quote(name)} WITH (FORCE);`);
  rmSync(scratch, { recursive: true, force: true });
  console.log('Owned scratch database and migration directory removed.');
}
