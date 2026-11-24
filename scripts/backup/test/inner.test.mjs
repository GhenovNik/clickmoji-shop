// Runs the committed container scripts (dump.sh, verify.sh) as real shell processes, with
// PostgreSQL tools replaced by logging shims on PATH. Each shim records its own argv and
// which libpq variables it received (presence only). No value of a variable is ever logged,
// so the synthetic password stays out of the test output as well.
// This covers the arguments and environment the inner processes really get; the SQL itself
// runs only in the integration test against a real PostgreSQL 17.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CONTAINER_DIR } from '../docker.mjs';
import { libpqEnv } from '../config.mjs';
import { syntheticDatabase } from './helpers.mjs';

const SHIM_TOOLS = ['pg_dump', 'psql', 'pg_restore', 'createdb', 'initdb', 'pg_ctl', 'chown'];

// A logging stand-in for a tool. The tool name is its own file name.
const SHIM = `#!/bin/sh
name=$(basename "$0")
{
  printf 'tool=%s\\n' "$name"
  for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done
  for var in PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE; do
    eval "value=\\\${$var:-}"
    if [ -n "$value" ]; then printf 'env=%s:set\\n' "$var"; fi
  done
} >> "$SHIM_LOG"
case "$name" in
  pg_dump)
    for arg in "$@"; do
      case "$arg" in --file=*) printf 'FAKE-DUMP' > "\${arg#--file=}" ;; esac
    done ;;
  psql)
    case "$*" in
      *_prisma_migrations*) cat "$SHIM_MIGRATION" ;;
      *query_to_xml*) cat "$SHIM_COUNTS" ;;
      *string_agg*) cat "$SHIM_IDENTITIES" ;;
    esac ;;
esac
exit 0
`;

// su-exec drops privileges in the real image; here it only logs and runs the command.
const SU_EXEC = `#!/bin/sh
{ printf 'tool=su-exec\\n'; for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done; } >> "$SHIM_LOG"
shift
exec "$@"
`;

let root;
let shimDir;
let work;
let cluster;
let log;
let db;
let fixtures;

function writeShim(name, body) {
  const file = path.join(shimDir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function shimLog() {
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

// The shim log as calls: tool name, argv entries and the variables that were present.
function shimCalls() {
  const calls = [];
  let current = null;
  for (const line of shimLog().split('\n')) {
    if (line.startsWith('tool=')) {
      current = { tool: line.slice(5), args: [], env: [] };
      calls.push(current);
    } else if (current && line.startsWith('arg=')) current.args.push(line.slice(4));
    else if (current && line.startsWith('env=')) current.env.push(line.slice(4));
  }
  return calls;
}

function innerEnv(extra = {}) {
  // Exactly what the host forwards by name for a container, from the synthetic address.
  const forwarded = libpqEnv(db.url);
  return {
    PATH: `${shimDir}:/bin:/usr/bin`,
    BACKUP_WORK: work,
    BACKUP_CLUSTER: cluster,
    SHIM_LOG: log,
    SHIM_IDENTITIES: fixtures.identities,
    SHIM_COUNTS: fixtures.counts,
    SHIM_MIGRATION: fixtures.migration,
    ...forwarded,
    ...extra,
  };
}

function runScript(script, env) {
  return spawnSync('/bin/sh', [path.join(CONTAINER_DIR, script)], { env, encoding: 'utf8' });
}

// Whatever the inner processes logged must never contain the synthetic secret or host.
function assertNoSecretInLog(message) {
  const text = shimLog();
  assert.equal(text.includes(db.password), false, `${message}: password in inner argv`);
  assert.equal(text.includes(db.host), false, `${message}: host in inner argv`);
  assert.equal(text.includes('postgresql://'), false, `${message}: URL in inner argv`);
}

beforeEach(() => {
  root = path.join(os.tmpdir(), `clickmoji-inner-test-${crypto.randomBytes(4).toString('hex')}`);
  shimDir = path.join(root, 'shims');
  work = path.join(root, 'work');
  cluster = path.join(root, 'cluster');
  log = path.join(root, 'inner.log');
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  for (const tool of SHIM_TOOLS) writeShim(tool, SHIM);
  writeShim('su-exec', SU_EXEC);
  db = syntheticDatabase();
  fixtures = {
    identities: path.join(root, 'identities.src'),
    counts: path.join(root, 'counts.src'),
    migration: path.join(root, 'migration.src'),
  };
  writeFileSync(
    fixtures.identities,
    'public."User"\tid int4 NOT NULL,email text NOT NULL\naudit.event\tid int4 NOT NULL\n'
  );
  writeFileSync(fixtures.counts, 'public."User"\t50\naudit.event\t3\n');
  writeFileSync(fixtures.migration, '20261124000000_add_ai_monthly_budgets\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('dump.sh as the inner process', () => {
  it('runs pg_dump with no connection string and the libpq variables from the environment', () => {
    const result = runScript('dump.sh', innerEnv());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(work, 'dump.custom'), 'utf8'), 'FAKE-DUMP');
    const log = shimLog();
    assert.match(log, /^tool=pg_dump$/m);
    assert.doesNotMatch(log, /^arg=postgres/m, 'no database name or URL positional argument');
    assert.match(log, /^env=PGPASSWORD:set$/m, 'password arrives by environment');
    assert.match(log, /^env=PGHOST:set$/m);
    assertNoSecretInLog('dump');
  });

  it('fails when pg_dump fails, so the host sees a non-zero exit', () => {
    writeShim('pg_dump', '#!/bin/sh\nexit 1\n');
    const result = runScript('dump.sh', innerEnv());
    assert.notEqual(result.status, 0);
  });
});

describe('verify.sh as the inner process', () => {
  it('compares every schema, keeps the migration semantics, and writes all reports', () => {
    const result = runScript('verify.sh', innerEnv());
    assert.equal(result.status, 0, result.stderr);
    const out = path.join(work, 'out');
    for (const file of [
      'source/identities.tsv',
      'source/migration.txt',
      'restored/identities.tsv',
      'restored/migration.txt',
      'restored/counts.tsv',
    ]) {
      assert.equal(existsSync(path.join(out, file)), true, `${file} written`);
    }
    assert.equal(
      readFileSync(path.join(out, 'restored/counts.tsv'), 'utf8'),
      readFileSync(fixtures.counts, 'utf8')
    );
    assert.equal(
      readFileSync(path.join(out, 'source/identities.tsv'), 'utf8'),
      readFileSync(fixtures.identities, 'utf8')
    );
    assert.equal(result.stdout.trim().endsWith('describe: done'), true);
    assertNoSecretInLog('verify');
  });

  it('reads the source with the password only; the local cluster never gets it', () => {
    const result = runScript('verify.sh', innerEnv());
    assert.equal(result.status, 0, result.stderr);
    const calls = shimCalls();
    const source = calls.filter(
      (call) =>
        call.tool === 'psql' &&
        !call.args.includes('-h') &&
        call.args.some((arg) => arg.includes('string_agg') || arg.includes('_prisma_migrations'))
    );
    assert.equal(source.length, 2, 'two source queries');
    for (const call of source)
      assert.ok(call.env.includes('PGPASSWORD:set'), 'source has password');

    const local = calls.filter((call) => call.args.includes('-h'));
    assert.ok(local.length >= 4, 'createdb, pg_restore and three restored queries');
    for (const call of local) {
      assert.equal(call.env.includes('PGPASSWORD:set'), false, `${call.tool} has no password`);
      assert.ok(
        call.args.includes('-p') && call.args.includes('5432'),
        `${call.tool} uses the socket port`
      );
    }
    assert.ok(
      calls.some(
        (call) => call.tool === 'pg_restore' && call.args.includes(path.join(work, 'dump.custom'))
      )
    );
    assertNoSecretInLog('verify local');
  });

  it('runs the server as the postgres user and keeps the cluster out of the work directory', () => {
    const result = runScript('verify.sh', innerEnv());
    assert.equal(result.status, 0, result.stderr);
    const calls = shimCalls();
    const serverStart = calls.find(
      (call) =>
        call.tool === 'su-exec' && call.args.includes('pg_ctl') && call.args.includes('start')
    );
    assert.ok(serverStart, 'server started through su-exec');
    assert.equal(serverStart.args[0], 'postgres');
    assert.equal(existsSync(path.join(work, 'pgdata')), false, 'no cluster in the work directory');
    assert.equal(
      existsSync(path.join(cluster, 'data')),
      true,
      'cluster in the container cluster directory'
    );
  });

  it('refuses to run when su-exec is missing from the image', () => {
    rmSync(path.join(shimDir, 'su-exec'));
    const result = spawnSync('/bin/sh', [path.join(CONTAINER_DIR, 'verify.sh')], {
      env: { ...innerEnv(), PATH: `${shimDir}:/nonexistent` },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /su-exec is missing/);
  });
});
