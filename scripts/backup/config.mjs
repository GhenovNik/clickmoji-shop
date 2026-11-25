// Configuration for the verified backup. Everything comes from the environment
// (plus the single-run --allow-row-drop CLI flag); nothing has a default for the
// database address or paths. Encryption is disabled by default (unencrypted pg_dump -Fc)
// and enabled explicitly with BACKUP_ENCRYPT=1.
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_RETENTION_COUNT, DOCKER_TIMEOUT_MS, REPO_ROOT } from './constants.mjs';
import { canonicalPath, isInsidePath } from './git.mjs';

export { REPO_ROOT };

// Bech32 alphabet; an age recipient is "age1" followed by 58 characters.
const AGE_RECIPIENT = /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/;

export class ConfigError extends Error {}

function requireAbsolute(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} не задан`);
  if (!path.isAbsolute(value)) throw new ConfigError(`${name}: нужен абсолютный путь`);
  // docker --mount splits on commas and colons, so such paths cannot be passed safely.
  if (/[,:]/.test(value)) throw new ConfigError(`${name}: путь содержит запрещённые символы`);
  return path.resolve(value);
}

// The status file is only ever appended to. It must not be a place where backup data lives:
// not inside the backup directory under any alias (symlinked parents included), not a symlink,
// and not a hard link, since a second name for a file could be a copy or a copy's metadata.
// Checked before anything runs, and again before each status write.
export function checkStatusTarget(statusFile, backupDir) {
  if (isInsidePath(canonicalPath(statusFile), canonicalPath(backupDir))) {
    throw new ConfigError('BACKUP_STATUS_FILE: путь внутри каталога резервных копий');
  }
  let stat;
  try {
    stat = lstatSync(statusFile);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new ConfigError('BACKUP_STATUS_FILE: файл не читается');
  }
  if (stat.isSymbolicLink()) throw new ConfigError('BACKUP_STATUS_FILE: символическая ссылка');
  if (!stat.isFile()) throw new ConfigError('BACKUP_STATUS_FILE: нужен обычный файл');
  if (stat.nlink > 1) throw new ConfigError('BACKUP_STATUS_FILE: жёсткая ссылка на другой файл');
}

// libpq variables that carry the source connection into the containers. Containers receive
// them by name (`-e PGHOST`), so no value is ever part of docker argv, and inside the
// container pg_dump, psql and pg_restore read them from the environment, not from argv.
export const LIBPQ_ENV_NAMES = Object.freeze([
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
]);

// URL query parameters that have a libpq environment equivalent. Any other parameter is
// refused: silently dropping a connection option would change how the copy is taken.
const QUERY_TO_LIBPQ = Object.freeze({
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  application_name: 'PGAPPNAME',
  channel_binding: 'PGCHANNELBINDING',
  options: 'PGOPTIONS',
});

// Prisma's own parameter; libpq does not know it, so it is dropped on purpose.
const IGNORED_QUERY = new Set(['schema']);

// Connection settings as libpq environment variables. localhost is not reachable from
// inside a container, so it maps to the host gateway.
export function libpqEnv(rawUrl) {
  const parsed = new URL(rawUrl);
  const env = {};
  for (const [key, value] of parsed.searchParams) {
    if (IGNORED_QUERY.has(key)) continue;
    const name = QUERY_TO_LIBPQ[key];
    if (!name) throw new ConfigError(`DATABASE_URL: параметр ${key} не поддерживается`);
    env[name] = value;
  }
  let host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === '127.0.0.1') host = 'host.docker.internal';
  env.PGHOST = host;
  env.PGPORT = parsed.port || '5432';
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database) env.PGDATABASE = database;
  const user = decodeURIComponent(parsed.username);
  if (user) env.PGUSER = user;
  const password = decodeURIComponent(parsed.password);
  if (password) env.PGPASSWORD = password;
  return env;
}

export function readRecipient(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (lines.length !== 1 || !AGE_RECIPIENT.test(lines[0])) {
    throw new ConfigError('BACKUP_AGE_RECIPIENT_FILE: нужен ровно один публичный ключ age');
  }
  return lines[0];
}

export function parseEncryptFlag(raw) {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  throw new ConfigError('BACKUP_ENCRYPT: ожидается 0 или 1');
}

export function parseRetentionCount(raw) {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_COUNT;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new ConfigError('BACKUP_RETENTION_COUNT: нужно целое число не меньше 1');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new ConfigError('BACKUP_RETENTION_COUNT: нужно целое число не меньше 1');
  }
  return count;
}

// Milliseconds a management docker call may take (see DOCKER_TIMEOUT_MS). Unset means the default.
export function parseDockerTimeout(raw) {
  if (raw === undefined || raw.trim() === '') return DOCKER_TIMEOUT_MS;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) throw new ConfigError('BACKUP_DOCKER_TIMEOUT_MS: нужно целое число мс');
  const ms = Number(value);
  if (ms < 100 || ms > 600_000) throw new ConfigError('BACKUP_DOCKER_TIMEOUT_MS: от 100 до 600000');
  return ms;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export function parseCliArgs(argv = []) {
  let allowRowDrop = false;
  let confirmEncryptedRestore = null;
  let confirmSha256 = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--allow-row-drop') {
      allowRowDrop = true;
    } else if (arg === '--confirm-encrypted-restore') {
      if (confirmEncryptedRestore !== null) {
        throw new ConfigError('повторный параметр --confirm-encrypted-restore');
      }
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new ConfigError('--confirm-encrypted-restore: укажите имя файла копии');
      }
      confirmEncryptedRestore = next.trim();
      if (!confirmEncryptedRestore) {
        throw new ConfigError('--confirm-encrypted-restore: укажите имя файла копии');
      }
      i += 1;
    } else if (arg.startsWith('--confirm-encrypted-restore=')) {
      if (confirmEncryptedRestore !== null) {
        throw new ConfigError('повторный параметр --confirm-encrypted-restore');
      }
      const value = arg.slice('--confirm-encrypted-restore='.length).trim();
      if (!value) {
        throw new ConfigError('--confirm-encrypted-restore: укажите имя файла копии');
      }
      confirmEncryptedRestore = value;
    } else if (arg === '--sha256') {
      if (confirmSha256 !== null) {
        throw new ConfigError('повторный параметр --sha256');
      }
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new ConfigError('--sha256: укажите SHA-256 снимка (64 hex-символа)');
      }
      const normalized = next.trim().toLowerCase();
      if (!SHA256_HEX.test(normalized)) {
        throw new ConfigError('--sha256: требуется SHA-256 из 64 шестнадцатеричных символов');
      }
      confirmSha256 = normalized;
      i += 1;
    } else if (arg.startsWith('--sha256=')) {
      if (confirmSha256 !== null) {
        throw new ConfigError('повторный параметр --sha256');
      }
      const normalized = arg.slice('--sha256='.length).trim().toLowerCase();
      if (!SHA256_HEX.test(normalized)) {
        throw new ConfigError('--sha256: требуется SHA-256 из 64 шестнадцатеричных символов');
      }
      confirmSha256 = normalized;
    } else {
      throw new ConfigError(`неизвестный параметр запуска: ${arg}`);
    }
  }
  if (confirmEncryptedRestore !== null && allowRowDrop) {
    throw new ConfigError('--confirm-encrypted-restore нельзя совмещать с --allow-row-drop');
  }
  if (confirmSha256 !== null && confirmEncryptedRestore === null) {
    throw new ConfigError('--sha256 используется только вместе с --confirm-encrypted-restore');
  }
  if (confirmEncryptedRestore !== null && confirmSha256 === null) {
    throw new ConfigError('--confirm-encrypted-restore требует обязательный параметр --sha256');
  }
  return confirmEncryptedRestore !== null
    ? { allowRowDrop: false, confirmEncryptedRestore, confirmSha256 }
    : { allowRowDrop };
}

function loadTargetPaths(env = process.env, { repoRoot = REPO_ROOT } = {}) {
  const backupDir = requireAbsolute(env, 'BACKUP_DIR');
  const statusFile = requireAbsolute(env, 'BACKUP_STATUS_FILE');

  checkStatusTarget(statusFile, backupDir);
  const resolvedRepoRoot = canonicalPath(repoRoot);
  if (
    isInsidePath(statusFile, repoRoot) ||
    isInsidePath(canonicalPath(statusFile), resolvedRepoRoot)
  ) {
    throw new ConfigError('BACKUP_STATUS_FILE: путь внутри репозитория');
  }

  return {
    backupDir,
    statusFile,
    gitBin: env.BACKUP_GIT_BIN?.trim() || 'git',
    dockerTimeoutMs: parseDockerTimeout(env.BACKUP_DOCKER_TIMEOUT_MS),
  };
}

// Confirmation does not connect to the database and requires neither DATABASE_URL nor age keys.
export function loadConfirmConfig(env = process.env, { repoRoot = REPO_ROOT } = {}) {
  return loadTargetPaths(env, { repoRoot });
}

// Loads status/backup target metadata before recipient validation so that when encryption
// is enabled and the public key is missing or unreadable, the CLI can still record the
// failure reason to BACKUP_STATUS_FILE when possible.
export function loadBaseConfig(env = process.env, { repoRoot = REPO_ROOT } = {}) {
  const rawUrl = env.DATABASE_URL?.trim();
  if (!rawUrl) throw new ConfigError('DATABASE_URL не задан');
  let protocol;
  try {
    protocol = new URL(rawUrl).protocol;
  } catch {
    throw new ConfigError('DATABASE_URL: неверный формат');
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new ConfigError('DATABASE_URL: ожидается схема postgres');
  }
  // DATABASE_URL is forwarded by name to the dump and verify containers; the libpq variables
  // are derived from this same value, so both describe one connection.
  const containerEnv = { ...libpqEnv(rawUrl), DATABASE_URL: rawUrl };
  const targets = loadTargetPaths(env, { repoRoot });

  const rawTmp = env.TMPDIR?.trim();
  if (rawTmp) {
    if (!path.isAbsolute(rawTmp)) throw new ConfigError('TMPDIR: нужен абсолютный путь');
    const resolvedTmp = canonicalPath(rawTmp);
    const resolvedRepoRoot = canonicalPath(repoRoot);
    if (
      isInsidePath(resolvedTmp, resolvedRepoRoot) ||
      isInsidePath(resolvedTmp, canonicalPath(targets.backupDir))
    ) {
      throw new ConfigError('TMPDIR: путь внутри репозитория или каталога резервных копий');
    }
  }

  return {
    containerEnv,
    ...targets,
    encrypt: parseEncryptFlag(env.BACKUP_ENCRYPT),
    keepCount: parseRetentionCount(env.BACKUP_RETENTION_COUNT),
    dockerBin: env.BACKUP_DOCKER_BIN?.trim() || 'docker',
  };
}

export function loadConfig(
  env = process.env,
  { repoRoot = REPO_ROOT, readFile = readFileSync } = {}
) {
  const base = loadBaseConfig(env, { repoRoot });
  let recipientFile = null;
  let recipient = null;

  if (base.encrypt) {
    recipientFile = requireAbsolute(env, 'BACKUP_AGE_RECIPIENT_FILE');
    try {
      recipient = readRecipient(readFile(recipientFile, 'utf8'));
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError('BACKUP_AGE_RECIPIENT_FILE: файл не читается');
    }
  }

  return {
    ...base,
    recipientFile,
    recipient,
  };
}
