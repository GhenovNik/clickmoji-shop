// Shared helpers for the backup tests. Every credential is generated at runtime and every
// file lives in a sandbox under the OS temp directory, outside the repository.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { DockerRunner } from '../docker.mjs';
import { runBackup } from '../pipeline.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLI = path.join(HERE, '..', 'cli.mjs');
export const FAKE_DOCKER = path.join(HERE, 'fake-docker.mjs');
chmodSync(FAKE_DOCKER, 0o755);

// Fixed clock for the tests: the new copy is named clickmoji-20261124T120000Z.dump.age.
export const NOW = new Date('2026-11-24T12:00:00.000Z');
export const NEW_NAME = 'clickmoji-20261124T120000Z.dump.age';

const AGE_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function randomRecipient() {
  let text = 'age1';
  for (const byte of crypto.randomBytes(58)) text += AGE_ALPHABET[byte % 32];
  return text;
}

export function makeSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-backup-test-'));
  const tmp = path.join(root, 'tmp');
  mkdirSync(tmp);
  const recipientFile = path.join(root, 'recipient.txt');
  writeFileSync(recipientFile, `# test recipient\n${randomRecipient()}\n`);
  return {
    root,
    tmp,
    backupDir: path.join(root, 'backups'),
    statusFile: path.join(root, 'status.log'),
    logFile: path.join(root, 'docker.log'),
    recipientFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// A database address that exists only in memory: the host is reserved (.invalid) and the
// password is random on every call.
export function syntheticDatabase() {
  const password = crypto.randomBytes(12).toString('hex');
  const host = 'synthetic-db.test.invalid';
  return {
    url: `postgresql://app_user:${password}@${host}:5432/clickmoji?sslmode=require&schema=public`,
    password,
    host,
  };
}

export function envFor(sandbox, db, extra = {}) {
  return {
    PATH: process.env.PATH,
    TMPDIR: sandbox.tmp,
    DATABASE_URL: db.url,
    BACKUP_DIR: sandbox.backupDir,
    BACKUP_STATUS_FILE: sandbox.statusFile,
    BACKUP_AGE_RECIPIENT_FILE: sandbox.recipientFile,
    BACKUP_DOCKER_BIN: FAKE_DOCKER,
    FAKE_DOCKER_LOG: sandbox.logFile,
    ...extra,
  };
}

// In-process run of the pipeline with the fake docker.
export async function runWithFake(sandbox, db, extra = {}, now = NOW) {
  const env = envFor(sandbox, db, extra);
  const config = loadConfig(env);
  const docker = new DockerRunner({
    bin: config.dockerBin,
    containerEnv: config.containerEnv,
    env,
  });
  return runBackup({ config, docker, now: () => now, tempRoot: sandbox.tmp });
}

// Spawns the real CLI and captures what it prints.
export function runCli(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

// Old copies, one per day going back from NOW, optionally with meta counts.
export function seedBackups(backupDir, count, { counts = null } = {}) {
  mkdirSync(path.join(backupDir, 'meta'), { recursive: true });
  const names = [];
  for (let day = 1; day <= count; day += 1) {
    const when = new Date(NOW.getTime() - day * 86_400_000);
    const iso = when
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    const name = `clickmoji-${iso}.dump.age`;
    writeFileSync(path.join(backupDir, name), `old ${day}`);
    names.push(name);
    if (day === 1 && counts) {
      writeFileSync(
        path.join(backupDir, 'meta', `${name}.json`),
        JSON.stringify({ name, verify: 'ok', counts })
      );
    }
  }
  return names;
}

export function listCopies(backupDir) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => name.endsWith('.dump.age'))
    .sort();
}

export function readStatus(sandbox) {
  return existsSync(sandbox.statusFile) ? readFileSync(sandbox.statusFile, 'utf8') : '';
}

export function readDockerLog(sandbox) {
  if (!existsSync(sandbox.logFile)) return [];
  return readFileSync(sandbox.logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export const LOCK = (backupDir) => path.join(backupDir, '.backup.lock');
