// Integration test with a real, disposable PostgreSQL 17 container and synthetic fixtures.
// Runs only when CLICKMOJI_BACKUP_INTEGRATION=1 and docker is reachable; otherwise skipped.
// The source is a local container created here and removed afterwards; no production or
// Neon database is involved. Credentials and keys are generated at runtime and never printed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildImageArgs, CONTAINER_DIR } from '../docker.mjs';
import { libpqEnv, LIBPQ_ENV_NAMES } from '../config.mjs';
import { EXIT, POSTGRES_BASE_IMAGE, TOOLS_IMAGE } from '../constants.mjs';
import { CLI, listCopies, lockIsFree, makeSandbox, readStatus, seedBackups } from './helpers.mjs';

const enabled = process.env.CLICKMOJI_BACKUP_INTEGRATION === '1';
const dockerUp =
  enabled && spawnSync('docker', ['version', '--format', '{{.Server.Version}}']).status === 0;

const docker = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', ...options });

const SCHEMA_SQL = `
CREATE TABLE "User" (id serial PRIMARY KEY, email text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "Product" (id serial PRIMARY KEY, title text NOT NULL);
CREATE TABLE _prisma_migrations (
  id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
  migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0);
INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
  VALUES ('1', 'x', now(), '20261101000000_init', 1),
         ('2', 'y', now(), '20261124000000_add_ai_monthly_budgets', 1);
INSERT INTO "User" (email) SELECT 'user' || g || '@example.invalid' FROM generate_series(1, 50) g;
INSERT INTO "Product" (title) SELECT 'synthetic ' || g FROM generate_series(1, 7) g;
-- A second schema: every user schema is compared, not only public.
CREATE SCHEMA audit;
CREATE TABLE audit.event (id serial PRIMARY KEY, kind text NOT NULL);
INSERT INTO audit.event (kind) SELECT 'synthetic' FROM generate_series(1, 3) g;
-- Bulk rows make the restore take long enough to interrupt while it is running.
CREATE TABLE "Bulk" (id serial PRIMARY KEY, payload text NOT NULL);
INSERT INTO "Bulk" (payload) SELECT repeat(md5(g::text), 8) FROM generate_series(1, 150000) g;
`;

// Containers this tool starts are named clickmoji-backup-<step>-<hex>.
const toolContainers = (step = '') =>
  docker(['ps', '-a', '--filter', `name=^clickmoji-backup-${step}`, '--format', '{{.Names}}'])
    .stdout.split('\n')
    .filter(Boolean);

async function waitUntil(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

// Every file under a directory, for finding plaintext or scratch left behind.
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  );
}

describe(
  'integration: real docker, disposable PostgreSQL 17',
  { skip: !dockerUp && 'set CLICKMOJI_BACKUP_INTEGRATION=1 and start Docker' },
  () => {
    const sandbox = makeSandbox();
    const container = `clickmoji-backup-itest-${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(16).toString('hex');
    const state = { url: null, host: '127.0.0.1', identity: null };

    it('builds the tools image and starts a source container with synthetic fixtures', () => {
      assert.equal(docker(buildImageArgs()).status, 0, 'tools image built from the pinned base');
      const run = docker(
        [
          'run',
          '-d',
          '--rm',
          '--name',
          container,
          '-e',
          'POSTGRES_PASSWORD',
          '-p',
          '127.0.0.1::5432',
          POSTGRES_BASE_IMAGE,
        ],
        {
          env: { ...process.env, POSTGRES_PASSWORD: password },
        }
      );
      assert.equal(run.status, 0, 'source container started');
      const port = docker(['port', container, '5432/tcp']).stdout.trim().split(':').pop();
      assert.match(port, /^\d+$/);
      state.url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (docker(['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) break;
        spawnSync('sleep', ['1']);
      }
      const load = docker(
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        {
          input: SCHEMA_SQL,
        }
      );
      assert.equal(load.status, 0, 'fixtures loaded');
    });

    it('the tools image is PostgreSQL 17 for dump and restore alike', () => {
      const version = docker([
        'run',
        '--rm',
        '--entrypoint',
        '/bin/sh',
        TOOLS_IMAGE,
        '-c',
        'pg_dump --version && pg_restore --version',
      ]);
      assert.equal(version.status, 0);
      assert.equal((version.stdout.match(/ 17\./g) ?? []).length, 2, 'both tools report 17.x');
    });

    it('publishes an encrypted copy that decrypts to a dump matching the source', () => {
      // age-keygen runs inside the tools image. The identity stays in the sandbox (0600); only the
      // public recipient is written to the config file.
      const keys = docker([
        'run',
        '--rm',
        '--entrypoint',
        '/bin/sh',
        TOOLS_IMAGE,
        '-c',
        'age-keygen',
      ]);
      const output = `${keys.stdout}${keys.stderr}`;
      const recipient = /^# public key: (age1\S+)$/m.exec(output)?.[1];
      const secret = /^(AGE-SECRET-KEY-\S+)$/m.exec(output)?.[1];
      assert.ok(recipient && secret, 'key pair generated');
      writeFileSync(sandbox.recipientFile, `${recipient}\n`);
      state.identity = path.join(sandbox.root, 'identity.txt');
      writeFileSync(state.identity, `${secret}\n`, { mode: 0o600 });

      const env = {
        PATH: process.env.PATH,
        TMPDIR: sandbox.tmp,
        DATABASE_URL: state.url,
        BACKUP_DIR: sandbox.backupDir,
        BACKUP_STATUS_FILE: sandbox.statusFile,
        BACKUP_AGE_RECIPIENT_FILE: sandbox.recipientFile,
      };
      const result = spawnSync(process.execPath, [CLI], { env, encoding: 'utf8' });
      assert.equal(result.status, EXIT.ok, 'run succeeded');
      const visible = `${result.stdout}${result.stderr}${readStatus(sandbox)}`;
      assert.doesNotMatch(visible, new RegExp(password));
      assert.doesNotMatch(visible, /127\.0\.0\.1/);

      const [copy] = listCopies(sandbox.backupDir);
      assert.ok(copy, 'a copy was published');
      const bytes = readFileSync(path.join(sandbox.backupDir, copy));
      assert.equal(bytes.subarray(0, 21).toString('utf8'), 'age-encryption.org/v1');
      assert.equal(
        bytes.includes(Buffer.from('user1@example.invalid')),
        false,
        'stored copy is not plaintext'
      );

      const decrypt = docker([
        'run',
        '--rm',
        '--mount',
        `type=bind,source=${sandbox.backupDir},target=/b,readonly`,
        '--mount',
        `type=bind,source=${state.identity},target=/k,readonly`,
        '--entrypoint',
        '/bin/sh',
        TOOLS_IMAGE,
        '-c',
        `age -d -i /k /b/${copy} > /tmp/restore.custom && pg_restore -l /tmp/restore.custom > /dev/null`,
      ]);
      assert.equal(decrypt.status, 0, 'copy decrypts and reads as a PostgreSQL custom dump');

      const meta = JSON.parse(
        readFileSync(path.join(sandbox.backupDir, 'meta', `${copy}.json`), 'utf8')
      );
      assert.equal(meta.verify, 'ok');
      assert.equal(meta.migration, '20261124000000_add_ai_monthly_budgets');
      assert.equal(meta.counts['public."User"'], 50);
      assert.equal(meta.counts['public."Product"'], 7);
      assert.equal(meta.counts['audit.event'], 3, 'a table outside public is counted');
    });

    it('a truncated dump fails the restore check', () => {
      const work = path.join(sandbox.tmp, 'corrupt');
      mkdirSync(work, { recursive: true });
      writeFileSync(path.join(work, 'dump.custom'), 'PGDMP-truncated');
      const result = docker(
        [
          'run',
          '--rm',
          ...['DATABASE_URL', ...LIBPQ_ENV_NAMES].flatMap((name) => ['-e', name]),
          '--mount',
          `type=bind,source=${work},target=/work`,
          '--mount',
          `type=bind,source=${CONTAINER_DIR},target=/opt/backup,readonly`,
          '--entrypoint',
          '/bin/sh',
          TOOLS_IMAGE,
          '/opt/backup/verify.sh',
        ],
        { env: { ...process.env, DATABASE_URL: state.url, ...libpqEnv(state.url) } }
      );
      assert.notEqual(result.status, 0, 'verification of a corrupt dump fails');
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(password));
    });

    it('a stop during the active dump leaves no container, scratch, plaintext, and no copy changed', async () => {
      const old = seedBackups(sandbox.backupDir, 3);
      const bytesBefore = old.map((name) =>
        readFileSync(path.join(sandbox.backupDir, name), 'utf8')
      );
      const serverSql = (sql) =>
        docker([
          'exec',
          container,
          'psql',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-tA',
          '-c',
          sql,
        ]).stdout.trim();

      // Hold the dump phase deterministically, without touching the tool. An access-exclusive lock
      // on the bulk table is taken in a psql session this test controls. pg_dump needs that table
      // and waits for the lock; the wait is observed on the server before the stop is sent, and the
      // session is rolled back only after the run has ended.
      const holder = spawn(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const holderClosed = new Promise((resolve) => holder.on('close', resolve));
      holder.stdin.write('BEGIN;\nLOCK TABLE "Bulk" IN ACCESS EXCLUSIVE MODE;\n');
      const held = await waitUntil(
        () =>
          serverSql(
            `SELECT count(*) FROM pg_locks WHERE relation = '"Bulk"'::regclass AND mode = 'AccessExclusiveLock' AND granted`
          ) === '1',
        30_000
      );
      assert.ok(held, 'the test holds the bulk table');

      const env = {
        PATH: process.env.PATH,
        TMPDIR: sandbox.tmp,
        DATABASE_URL: state.url,
        BACKUP_DIR: sandbox.backupDir,
        BACKUP_STATUS_FILE: sandbox.statusFile,
        BACKUP_AGE_RECIPIENT_FILE: sandbox.recipientFile,
      };
      const child = spawn(process.execPath, [CLI], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const exited = new Promise((resolve) =>
        child.on('close', (code, signal) => resolve(code ?? `signal:${signal}`))
      );

      const waiting = await waitUntil(
        () =>
          toolContainers('dump-')[0] &&
          serverSql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'`) !== '0',
        120_000
      );
      assert.ok(waiting, 'the dump container is running and waiting on the held table');
      const active = toolContainers('dump-')[0];
      assert.equal(
        docker(['inspect', '--format', '{{.HostConfig.LogConfig.Type}}', active]).stdout.trim(),
        'none',
        'the active container keeps no daemon log'
      );

      child.kill('SIGTERM');
      const code = await exited;
      holder.stdin.end('ROLLBACK;\n');
      await holderClosed;
      assert.equal(code, EXIT.interrupted);

      assert.deepEqual(toolContainers(), [], 'no tool container survives the stop');
      const scratch = filesUnder(sandbox.tmp).filter((file) => /dump\.(custom|age)$/.test(file));
      assert.deepEqual(scratch, [], 'no plaintext or ciphertext scratch file is left');
      assert.equal(await lockIsFree(sandbox.backupDir), true, 'lock released');
      assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort(), 'copies unchanged');
      old.forEach((name, i) =>
        assert.equal(readFileSync(path.join(sandbox.backupDir, name), 'utf8'), bytesBefore[i])
      );
      assert.doesNotMatch(`${output}${readStatus(sandbox)}`, new RegExp(password));
      assert.match(readStatus(sandbox), /\tfailed\tсбой: прервано\n$/);
    });

    it('removes the source container and the sandbox', () => {
      docker(['rm', '-f', container]);
      assert.notEqual(docker(['inspect', container]).status, 0);
      sandbox.cleanup();
    });
  }
);
