// One backup at a time per backup directory.
//
// The lock is a file that appears whole: its owner record (pid and random token) is written to a
// private temporary file first, then `link(2)` gives it the lock name. link fails when the name
// exists, so there is exactly one creator, and no reader ever sees a lock without its record.
//
// Only the holder of a token may remove its lock (release is owner-bound). A lock whose pid is
// gone is taken over this way: the stale file is renamed away, and the renamed file must be the
// very inode that was judged stale. A different inode means a live lock was moved by mistake; it
// is linked back and the caller gives up. Leftovers of a crashed run (temporary files and
// renamed-away locks) are swept by pid, so an abandoned acquisition never blocks the directory.
import crypto from 'node:crypto';
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { LOCK_NAME } from './constants.mjs';

const TMP_MARK = `${LOCK_NAME}.tmp-`;
const REAP_MARK = `${LOCK_NAME}.reap-`;
const ATTEMPTS = 5;

// True when a process with this pid exists (EPERM means it exists under another user).
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Identity and owner record of the entry at `file`, or null when there is no entry. A record
// that cannot be parsed has pid and token null: it is never a live owner's record.
function readRecord(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const record = { dev: stat.dev, ino: stat.ino, pid: null, token: null };
  if (!stat.isFile()) return record;
  let fd;
  try {
    fd = openSync(file, 'r');
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return record;
    const meta = JSON.parse(readFileSync(fd, 'utf8'));
    if (Number.isInteger(meta?.pid)) record.pid = meta.pid;
    if (typeof meta?.token === 'string') record.token = meta.token;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return record;
}

function removeQuietly(file) {
  rmSync(file, { recursive: true, force: true });
}

// Leftovers of crashed runs. Temporary records of dead processes are removed. A renamed-away
// lock of a dead owner is removed; one that is still alive was moved by mistake, so it goes back.
function sweepLeftovers(backupDir, lockFile) {
  let names;
  try {
    names = readdirSync(backupDir);
  } catch {
    return;
  }
  for (const name of names) {
    const isTmp = name.startsWith(TMP_MARK);
    const isReap = name.startsWith(REAP_MARK);
    if (!isTmp && !isReap) continue;
    const file = path.join(backupDir, name);
    const record = readRecord(file);
    if (!record) continue;
    if (record.pid !== null && pidAlive(record.pid)) {
      if (isReap) restoreLock(file, lockFile);
      continue;
    }
    removeQuietly(file);
  }
}

// Puts a renamed-away live lock back under the lock name, unless another lock took the name.
function restoreLock(reapFile, lockFile) {
  try {
    linkSync(reapFile, lockFile);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  removeQuietly(reapFile);
}

// Takes over a lock judged stale. True: the stale record was removed and acquisition may retry.
// False: the record moved was not the stale one, so it was restored and this run must stop.
function reapStale(backupDir, lockFile, judged) {
  const reapFile = path.join(
    backupDir,
    `${REAP_MARK}${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  try {
    renameSync(lockFile, reapFile);
  } catch (error) {
    if (error.code === 'ENOENT') return true; // someone else removed it first
    throw error;
  }
  const moved = readRecord(reapFile);
  if (!moved) return true; // the leftover was swept concurrently; retry
  if (moved.dev === judged.dev && moved.ino === judged.ino) {
    removeQuietly(reapFile);
    return true;
  }
  restoreLock(reapFile, lockFile);
  return false;
}

function ownedBy(lockFile, token) {
  return {
    held() {
      return readRecord(lockFile)?.token === token;
    },
    release() {
      if (readRecord(lockFile)?.token === token) removeQuietly(lockFile);
    },
  };
}

// Returns { held(), release() } for this run, or null when another live run holds the lock.
// Throws only for an unexpected filesystem error; the caller reports that as busy.
export function acquireLock(backupDir) {
  const lockFile = path.join(backupDir, LOCK_NAME);
  sweepLeftovers(backupDir, lockFile);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const token = crypto.randomBytes(16).toString('hex');
    const tmpFile = path.join(backupDir, `${TMP_MARK}${process.pid}-${token}`);
    writeFileSync(tmpFile, JSON.stringify({ pid: process.pid, token }), {
      mode: 0o600,
      flag: 'wx',
    });
    let created = false;
    try {
      linkSync(tmpFile, lockFile);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        removeQuietly(tmpFile);
        throw error;
      }
    }
    removeQuietly(tmpFile);
    if (created) return ownedBy(lockFile, token);

    const current = readRecord(lockFile);
    if (!current) continue; // released meanwhile
    if (current.pid !== null && pidAlive(current.pid)) return null;
    if (!reapStale(backupDir, lockFile, current)) return null;
  }
  return null;
}
