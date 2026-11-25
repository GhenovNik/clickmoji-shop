// Shared filesystem, metadata inspection, and status-reporting primitives for verified backups.
import crypto from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { checkStatusTarget } from './config.mjs';
import {
  BACKUP_NAME_PATTERN,
  EXIT,
  MESSAGES,
  META_DIR,
  WAITING_CONFIRMATION_NOTE,
} from './constants.mjs';
import { appendStatus, formatStatusLine } from './status.mjs';

export class StepError extends Error {
  constructor(key, exit) {
    super(key);
    this.key = key;
    this.exit = exit;
  }
}

// 20261124T120000Z: sorts chronologically and is safe in file names.
export function stamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function parseStampTime(rawStamp) {
  const iso = `${rawStamp.slice(0, 4)}-${rawStamp.slice(4, 6)}-${rawStamp.slice(6, 8)}T${rawStamp.slice(9, 11)}:${rawStamp.slice(11, 13)}:${rawStamp.slice(13, 15)}Z`;
  return new Date(iso);
}

export const sha256Buffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const sha256File = (file) => sha256Buffer(readFileSync(file));
export const sha256Text = (text) => sha256Buffer(Buffer.from(text, 'utf8'));

export function fsyncFile(file) {
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

// Creates destFile with mode 0600 from its very creation (even under a permissive umask)
// and copies sourceFile without exposing a world-readable intermediate file.
export function writePrivateCopy(sourceFile, destFile) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const srcFd = openSync(sourceFile, 'r');
  let destFd = null;
  try {
    destFd = openSync(destFile, flags, 0o600);
    if ((fstatSync(destFd).mode & 0o777) !== 0o600) {
      throw new Error('destination file permissions are not 0600');
    }
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = readSync(srcFd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        offset += writeSync(destFd, buf, offset, bytesRead - offset);
      }
    }
    fsyncSync(destFd);
  } finally {
    if (destFd !== null) closeSync(destFd);
    closeSync(srcFd);
  }
}

export function writePrivateText(destFile, text) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(destFile, flags, 0o600);
  try {
    if ((fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error('metadata file permissions are not 0600');
    }
    const data = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function isValidCounts(counts) {
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) return false;
  return Object.values(counts).every((value) => Number.isInteger(value) && value >= 0);
}

// Completed, accepted copies in the backup directory, by the time in their file name.
// Recognizes both unencrypted (.dump) and encrypted (.dump.age) copies and uses a single
// publication completeness model across baseline comparison, transition retention, and cleanup.
export function inspectCompletedBackup(backupDir, name, match) {
  const dumpPath = path.join(backupDir, name);
  let dumpLstat;
  try {
    dumpLstat = lstatSync(dumpPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'incomplete' };
    throw new StepError('verify', EXIT.failed);
  }
  if (dumpLstat.isSymbolicLink() || !dumpLstat.isFile()) {
    throw new StepError('verify', EXIT.failed);
  }
  if (dumpLstat.size <= 0) {
    return { status: 'incomplete' };
  }

  const metaPath = path.join(backupDir, META_DIR, `${name}.json`);
  let metaLstat;
  try {
    metaLstat = lstatSync(metaPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'incomplete' };
    throw new StepError('verify', EXIT.failed);
  }
  if (metaLstat.isSymbolicLink() || !metaLstat.isFile()) {
    throw new StepError('verify', EXIT.failed);
  }

  let raw;
  try {
    raw = readFileSync(metaPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'incomplete' };
    throw new StepError('verify', EXIT.failed);
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw new StepError('verify', EXIT.failed);
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new StepError('verify', EXIT.failed);
  }
  if (meta.name !== undefined && meta.name !== name) {
    throw new StepError('verify', EXIT.failed);
  }
  const encrypted = Boolean(match[2]);
  if (meta.encrypted !== undefined && meta.encrypted !== encrypted) {
    throw new StepError('verify', EXIT.failed);
  }
  if (meta.verify === 'suspicious') {
    return { status: 'legacy-suspicious' };
  }
  if (meta.verify !== 'ok' || !isValidCounts(meta.counts)) {
    throw new StepError('verify', EXIT.failed);
  }

  return {
    status: 'complete',
    entry: {
      name,
      time: parseStampTime(match[1]),
      encrypted,
      counts: new Map(Object.entries(meta.counts)),
    },
  };
}

export function listBackups(backupDir) {
  if (!existsSync(backupDir)) return [];
  const completed = [];
  for (const name of readdirSync(backupDir)) {
    const match = BACKUP_NAME_PATTERN.exec(name);
    if (!match) continue;
    const inspected = inspectCompletedBackup(backupDir, name, match);
    if (inspected.status === 'complete') completed.push(inspected.entry);
  }
  return completed;
}

export function removeCopyWithMeta(backupDir, name) {
  rmSync(path.join(backupDir, name), { force: true });
  rmSync(path.join(backupDir, META_DIR, `${name}.json`), { force: true });
}

// Removes orphaned dumps lacking committed acceptance metadata (e.g. crash between the two
// renames) and leftover .partial-* files after a successful publication under the held lock.
export function cleanupIncompletePublishes(backupDir) {
  for (const name of readdirSync(backupDir)) {
    if (name.startsWith('.partial-')) {
      rmSync(path.join(backupDir, name), { force: true });
      continue;
    }
    const match = BACKUP_NAME_PATTERN.exec(name);
    if (!match) continue;
    const inspected = inspectCompletedBackup(backupDir, name, match);
    if (inspected.status === 'incomplete') {
      rmSync(path.join(backupDir, name), { force: true });
    }
  }
  const metaDir = path.join(backupDir, META_DIR);
  if (existsSync(metaDir)) {
    for (const name of readdirSync(metaDir)) {
      if (name.startsWith('.partial-')) {
        rmSync(path.join(metaDir, name), { force: true });
      }
    }
  }
}

function formatOkDetail(result) {
  if (result.confirmFile) {
    return `confirm-encrypted-restore file=${result.confirmFile} sha256=${result.sha256}`;
  }
  if (result.waitingForConfirmation) {
    return `size=${result.sizeBytes} verify=${result.verify} decrypt=unconfirmed file=${result.name} prune=${result.pruned} (${WAITING_CONFIRMATION_NOTE})`;
  }
  return `size=${result.sizeBytes} verify=${result.verify} file=${result.name} prune=${result.pruned}`;
}

// `saved` is true when the copy or confirmation state was saved, whatever happened afterwards.
// A status line that cannot be written (the path no longer qualifies, or the write fails) is
// reported as statusWritten: false.
export function report(config, now, result, saved = false, statusFailedExit = EXIT.statusFailed) {
  const when = now();
  const detailText = result.detail ?? (result.ok ? null : MESSAGES[result.key]);
  const line = result.ok
    ? formatStatusLine({
        now: when,
        outcome: 'ok',
        detail: formatOkDetail(result),
      })
    : formatStatusLine({ now: when, outcome: 'failed', detail: detailText });
  // The status path is checked again: a file may have been replaced since configuration.
  let statusWritten = true;
  try {
    checkStatusTarget(config.statusFile, config.backupDir);
    appendStatus(config.statusFile, line);
  } catch {
    statusWritten = false; // nothing is written to a path that no longer qualifies
  }
  const outcomeExit = result.ok ? EXIT.ok : result.exit;
  return {
    ...result,
    saved,
    statusWritten,
    exit: !statusWritten && saved ? statusFailedExit : outcomeExit,
  };
}

export function reportFailure(config, key, exit, now = () => new Date(), detail = undefined) {
  return report(config, now, { ok: false, key, exit, detail });
}

// The outcome of a run that could not take the lock. Used by the entry point, which holds no lock
// when another process does.
export function reportBusy(config, now = () => new Date()) {
  return reportFailure(config, 'busy', EXIT.busy, now);
}
