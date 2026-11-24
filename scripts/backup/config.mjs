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

// Address for the containers: the process env carries it, argv never does.
// localhost is not reachable from inside a container, so it maps to the host gateway.
export function containerDatabaseUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.searchParams.delete('schema');
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    parsed.hostname = 'host.docker.internal';
  }
  return parsed.toString();
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
    databaseUrl: rawUrl,
    containerDatabaseUrl: containerDatabaseUrl(rawUrl),
    backupDir,
    statusFile,
    recipientFile,
    recipient,
    dockerBin: env.BACKUP_DOCKER_BIN?.trim() || 'docker',
  };
}
