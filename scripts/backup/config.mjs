// Configuration for the verified backup. Everything comes from the environment;
// nothing has a default for the database address, the recipient, or the paths.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

export function loadConfig(
  env = process.env,
  { repoRoot = REPO_ROOT, readFile = readFileSync } = {}
) {
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
  const containerEnv = libpqEnv(rawUrl);

  const backupDir = requireAbsolute(env, 'BACKUP_DIR');
  const statusFile = requireAbsolute(env, 'BACKUP_STATUS_FILE');
  const recipientFile = requireAbsolute(env, 'BACKUP_AGE_RECIPIENT_FILE');

  for (const [name, target] of [
    ['BACKUP_DIR', backupDir],
    ['BACKUP_STATUS_FILE', statusFile],
  ]) {
    if (isInside(target, repoRoot)) throw new ConfigError(`${name}: путь внутри репозитория`);
  }

  let recipient;
  try {
    recipient = readRecipient(readFile(recipientFile, 'utf8'));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('BACKUP_AGE_RECIPIENT_FILE: файл не читается');
  }

  return {
    containerEnv,
    backupDir,
    statusFile,
    recipientFile,
    recipient,
    dockerBin: env.BACKUP_DOCKER_BIN?.trim() || 'docker',
  };
}
