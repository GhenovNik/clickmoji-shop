#!/usr/bin/env node
// Test double for the docker CLI. It appends every argv and digests of the forwarded libpq variables
// to FAKE_DOCKER_LOG (a file inside the test sandbox) and emulates the few commands the
// pipeline issues. Behaviour is selected with FAKE_DOCKER_MODE:
//   ok | docker-down | pull-fail | dump-fail | interrupt | verify-fail | encrypt-fail | cleanup-fail
// cleanup-fail leaves a directory the host cannot remove and makes the in-image cleanup a no-op.
import { appendFileSync, chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

// Source variables the host forwards by name. Only digests of their values are logged.
const PG_NAMES = [
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGCONNECT_TIMEOUT',
  'PGAPPNAME',
  'PGCHANNELBINDING',
  'PGOPTIONS',
];
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

const argv = process.argv.slice(2);
const mode = process.env.FAKE_DOCKER_MODE || 'ok';

if (process.env.FAKE_DOCKER_LOG) {
  appendFileSync(
    process.env.FAKE_DOCKER_LOG,
    `${JSON.stringify({
      argv,
      // Docker passes a variable into the container only when argv names it with -e.
      forwarded: Object.fromEntries(
        PG_NAMES.filter((name) => argv.includes(name) && process.env[name] !== undefined).map(
          (name) => [name, digest(process.env[name])]
        )
      ),
    })}\n`
  );
}

// Host directory mounted at the given container path.
function mountSource(target) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--mount') continue;
    const match = /source=([^,]+),target=([^,]+)/.exec(argv[i + 1]);
    if (match && match[2] === target) return match[1];
  }
  return null;
}

const entrypoint = () => argv[argv.indexOf('--entrypoint') + 1];

function writeReports(workDir) {
  const out = path.join(workDir, 'out');
  mkdirSync(path.join(out, 'source'), { recursive: true });
  mkdirSync(path.join(out, 'restored'), { recursive: true });
  const identities = process.env.FAKE_IDENTITIES ?? 'a\tid int4 NO\nb\tid int4 NO';
  const restoredIdentities = process.env.FAKE_RESTORED_IDENTITIES ?? identities;
  const counts = process.env.FAKE_COUNTS ?? '{"a":10,"b":20}';
  const countLines = Object.entries(JSON.parse(counts))
    .map(([table, n]) => `${table}\t${n}`)
    .join('\n');
  writeFileSync(path.join(out, 'source', 'identities.tsv'), `${identities}\n`);
  writeFileSync(
    path.join(out, 'source', 'migration.txt'),
    `${process.env.FAKE_MIGRATION ?? 'm_2'}\n`
  );
  writeFileSync(path.join(out, 'restored', 'identities.tsv'), `${restoredIdentities}\n`);
  writeFileSync(
    path.join(out, 'restored', 'migration.txt'),
    `${process.env.FAKE_RESTORED_MIGRATION ?? process.env.FAKE_MIGRATION ?? 'm_2'}\n`
  );
  writeFileSync(path.join(out, 'restored', 'counts.tsv'), `${countLines}\n`);
  if (mode === 'cleanup-fail') {
    // A read-only directory with a file in it: the host cannot delete it without privilege.
    chmodSync(path.join(out, 'restored'), 0o555);
  }
}

if (argv[0] === 'version') {
  if (mode === 'docker-down') {
    // Real docker may echo the connection string; the pipeline must not forward it.
    process.stderr.write(`Cannot connect to ${process.env.PGPASSWORD ?? ''}\n`);
    process.exit(1);
  }
  process.stdout.write('29.9.3\n');
  process.exit(0);
}

if (argv[0] === 'image' && argv[1] === 'inspect') process.exit(mode === 'pull-fail' ? 1 : 0);
if (argv[0] === 'build') process.exit(mode === 'pull-fail' ? 1 : 0);
if (argv[0] === 'rm') process.exit(0);

function runContainer() {
  const workDir = mountSource('/work');
  if (argv.includes('/opt/backup/dump.sh')) {
    writeFileSync(path.join(workDir, 'dump.custom'), 'FAKE-DUMP');
    if (mode === 'interrupt') {
      // Plaintext exists now; the host must kill this process and clean up.
      setInterval(() => {}, 1000);
      return undefined;
    }
    return mode === 'dump-fail' ? 1 : 0;
  }
  if (argv.includes('/opt/backup/verify.sh')) {
    if (mode === 'verify-fail') return 1;
    writeReports(workDir);
    return 0;
  }
  if (entrypoint() === 'age') {
    if (mode === 'encrypt-fail') return 1;
    writeFileSync(path.join(workDir, 'dump.age'), 'age-encryption.org/v1\nFAKE-CIPHERTEXT\n');
    return 0;
  }
  if (argv.some((arg) => arg.includes('rm -rf'))) {
    if (mode === 'cleanup-fail') return 0;
    for (const entry of readdirSync(workDir))
      rmSync(path.join(workDir, entry), { recursive: true, force: true });
    return 0;
  }
  return 2;
}

if (argv[0] === 'run') {
  const code = runContainer();
  if (code !== undefined) process.exit(code);
} else {
  process.exit(2);
}
