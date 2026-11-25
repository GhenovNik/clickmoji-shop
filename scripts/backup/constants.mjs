// Shared constants for the verified PostgreSQL backup (AGE-1669).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROJECT_NAME = 'clickmoji-shop';

// Index digest of the official postgres:17-alpine tag, read from the registry on
// 2026-11-24. Dump, restore, describe and encrypt all run from one image built on it.
// Refreshing the digest is a separate change: re-read it, update this constant and
// the FROM line of Dockerfile.tools together (a test checks they match).
export const POSTGRES_BASE_DIGEST =
  'sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73';
export const POSTGRES_BASE_IMAGE = `postgres:17-alpine@${POSTGRES_BASE_DIGEST}`;
export const TOOLS_IMAGE = `clickmoji-backup-tools:pg17-${POSTGRES_BASE_DIGEST.slice(7, 19)}`;

// A table whose row count falls by more than this share versus the previous good copy is flagged.
export const DROP_THRESHOLD_PERCENT = 20;

// Bounds for docker calls that are not container runs: version, ps, rm, create, image inspect.
// A call that does not answer in time is killed and its outcome is unknown. The default may be
// overridden with BACKUP_DOCKER_TIMEOUT_MS (milliseconds, see config.mjs). Image build is slower.
export const DOCKER_TIMEOUT_MS = 20_000;
export const BUILD_TIMEOUT_MS = 15 * 60_000;

// Keep the N newest successful copies (default 2).
export const DEFAULT_RETENTION_COUNT = 2;

export const BACKUP_PREFIX = 'clickmoji-';
export const BACKUP_PLAIN_SUFFIX = '.dump';
export const BACKUP_ENCRYPTED_SUFFIX = '.dump.age';
export const BACKUP_SUFFIX = BACKUP_ENCRYPTED_SUFFIX;
export const BACKUP_NAME_PATTERN = /^clickmoji-(\d{8}T\d{6}Z)\.dump(\.age)?$/;
export const META_DIR = 'meta';
export const LOCK_NAME = '.backup.lock';
// Containers started by a run that the daemon has not yet been seen to remove (the recovery marker).
export const LEDGER_NAME = '.backup.ledger';
// Operator confirmation state for the first restored encrypted copy before purging plaintext dumps.
export const ENCRYPTED_CONFIRM_STATE_NAME = '.encrypted-restore-confirmed.json';
// Durable policy storing the confirmed public age recipient across cutover, restarts, and mode switches.
export const CONFIRMED_RECIPIENT_STATE_NAME = '.confirmed-recipient.json';
export const TEMP_PREFIX = 'clickmoji-backup-';
// Written into every temporary directory first; removed last, and never by a container's cleanup.
export const TEMP_MARKER = 'owner.json';
export const WAITING_CONFIRMATION_NOTE =
  'шифрование включено, открытые копии ждут подтверждения восстановления';
export const WAITING_FIRST_CONFIRMATION_NOTE =
  'шифрование включено, первая копия ждёт подтверждения восстановления';

// Process exit codes.
export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  suspicious: 2,
  busy: 3,
  unavailable: 4,
  interrupted: 130,
  // The copy was published, but its status line could not be written. Distinct from every
  // failure code, so a scheduler can tell "copy saved, status missing" from "copy not saved".
  statusFailed: 5,
});

// Fixed, sanitized status texts. They never contain a database address, a
// credential, a table name or a row count; docker stderr is never echoed.
export const MESSAGES = Object.freeze({
  docker: 'сбой: docker недоступен',
  image: 'сбой: не удалось получить образ',
  git: 'сбой: git недоступен',
  notMainBackups: 'сбой: каталог резервных копий должен быть backups/ основной копии проекта',
  notIgnored: 'сбой: каталог резервных копий не игнорируется git',
  noReadonlyRole: 'сбой: нет роли только на чтение в связке ключей',
  dump: 'сбой: снятие не удалось',
  verify: 'сбой: проверка не пройдена',
  drop: 'сбой: число строк упало более чем на 20%',
  encrypt: 'сбой: шифрование не удалось',
  publish: 'сбой: публикация не удалась',
  confirmTarget: 'сбой: копия для подтверждения отсутствует или не подходит',
  confirmCorrupt: 'сбой: копия для подтверждения повреждена или подменена',
  confirmDigestMismatch: 'сбой: SHA-256 копии не совпадает с восстановленным снимком',
  confirmStale: 'сбой: копия устарела для текущего перехода к шифрованию',
  confirmState: 'сбой: состояние подтверждения повреждено',
  confirmStatusSaved: 'сбой: подтверждение сохранено, статус не записан',
  recipientPolicy: 'сбой: политика подтверждённого получателя age повреждена',
  recipientMismatch: 'сбой: публичный ключ age не совпадает с подтверждённым получателем',
  transitionLimitTooLow:
    'сбой: лимит BACKUP_RETENTION_COUNT слишком мал для периода перехода; поднимите BACKUP_RETENTION_COUNT на период перехода',
  confirmFirstEncrypted:
    'сбой: первая зашифрованная копия не подтверждена; подтвердите восстановление копии или поднимите BACKUP_RETENTION_COUNT',
  corruptBackup: 'сбой: нарушена или не подтверждена целостность существующей резервной копии',
  busy: 'сбой: уже выполняется другое снятие',
  cleanup: 'сбой: очистка временной папки не удалась',
  containers: 'сбой: не удалось подтвердить остановку контейнера',
  status: 'сбой: статус не записан',
  statusSaved: 'сбой: копия сохранена, статус не записан',
  internal: 'сбой: внутренняя ошибка',
  interrupted: 'сбой: прервано',
});
