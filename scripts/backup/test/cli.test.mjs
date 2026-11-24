// CLI tests: the real entry point as a child process, so what it prints is what we assert on.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CLI,
  LOCK,
  envFor,
  listCopies,
  makeSandbox,
  readStatus,
  runCli,
  seedBackups,
  syntheticDatabase,
} from './helpers.mjs';
import { EXIT } from '../constants.mjs';

let sandbox;
let db;

beforeEach(() => {
  sandbox = makeSandbox();
  db = syntheticDatabase();
});

afterEach(() => {
  sandbox.cleanup();
});

const tempLeft = () =>
  readdirSync(sandbox.tmp).filter((name) => name.startsWith('clickmoji-backup-'));

function assertNoSecrets(text) {
  assert.ok(!text.includes(db.password), 'password not printed');
  assert.ok(!text.includes(db.host), 'host not printed');
  assert.ok(!text.includes('postgresql://'), 'URL not printed');
}

describe('cli failure outcomes', () => {
  it('docker unavailable: literal sanitized status, non-zero exit, old copies intact', async () => {
    const old = seedBackups(sandbox.backupDir, 20);
    const result = await runCli(envFor(sandbox, db, { FAKE_DOCKER_MODE: 'docker-down' }));

    assert.equal(result.code, EXIT.unavailable);
    assert.notEqual(result.code, 0);
    assert.equal(readStatus(sandbox).trim().split('\t')[2], 'сбой: docker недоступен');
    assert.match(readStatus(sandbox), /\tfailed\tсбой: docker недоступен\n$/);
    assert.match(result.stdout, /сбой: docker недоступен/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
  });

  it('image pull failed: explicit status, non-zero exit, old copies intact', async () => {
    const old = seedBackups(sandbox.backupDir, 20);
    const result = await runCli(envFor(sandbox, db, { FAKE_DOCKER_MODE: 'pull-fail' }));

    assert.equal(result.code, EXIT.unavailable);
    assert.match(readStatus(sandbox), /\tfailed\tсбой: не удалось получить образ\n$/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
    assert.deepEqual(tempLeft(), []);
  });

  it('a configuration error exits non-zero and prints no value', async () => {
    const env = envFor(sandbox, db);
    delete env.BACKUP_AGE_RECIPIENT_FILE;
    const result = await runCli(env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /BACKUP_AGE_RECIPIENT_FILE не задан/);
    assertNoSecrets(result.stdout + result.stderr);
  });

  it('a successful run prints no address, credential or count', async () => {
    seedBackups(sandbox.backupDir, 3);
    const result = await runCli(envFor(sandbox, db));
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout, /^backup: ok clickmoji-\d{8}T\d{6}Z\.dump\.age verify=ok\n$/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
  });
});

describe('interruption after plaintext exists', () => {
  it('SIGTERM kills the dump container, removes plaintext and the cluster, releases the lock', async () => {
    const old = seedBackups(sandbox.backupDir, 20);
    const env = envFor(sandbox, db, { FAKE_DOCKER_MODE: 'interrupt' });
    const child = spawn(process.execPath, [CLI], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    // Wait until plaintext exists in the private temp directory.
    const plaintextSeen = await waitFor(() => findPlaintext(sandbox.tmp), 15_000);
    assert.ok(plaintextSeen, 'plaintext dump was written before the interruption');

    child.kill('SIGTERM');
    const code = await new Promise((resolve) =>
      child.on('close', (exitCode, signal) => resolve(exitCode ?? `signal:${signal}`))
    );

    assert.equal(code, EXIT.interrupted);
    assert.equal(findPlaintext(sandbox.tmp), null, 'plaintext removed');
    assert.deepEqual(tempLeft(), [], 'temporary directory removed');
    assert.equal(existsSync(LOCK(sandbox.backupDir)), false, 'lock released');
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort(), 'old copies intact');
    assert.match(readStatus(sandbox), /\tfailed\tсбой: прервано\n$/);
    assertNoSecrets(stdout + stderr + readStatus(sandbox));
  });
});

// Looks for the plaintext dump inside any clickmoji-backup-* directory under the sandbox temp.
function findPlaintext(tmp) {
  for (const entry of readdirSync(tmp)) {
    if (!entry.startsWith('clickmoji-backup-')) continue;
    const file = path.join(tmp, entry, 'dump.custom');
    try {
      if (statSync(file).size > 0) return file;
    } catch {
      // Not written yet.
    }
  }
  return null;
}

async function waitFor(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}
