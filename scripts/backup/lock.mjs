// One backup at a time per backup directory. The lock is a directory (mkdir is atomic)
// holding the owner's pid; a lock whose owner is gone is taken over.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOCK_NAME } from './constants.mjs';

function ownerAlive(lockDir) {
  let pid;
  try {
    pid = Number(readFileSync(path.join(lockDir, 'pid'), 'utf8'));
  } catch {
    return true; // the owner is still writing its pid: treat as busy
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Returns { release() } or null when another live run holds the lock.
export function acquireLock(backupDir) {
  const lockDir = path.join(backupDir, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (ownerAlive(lockDir)) return null;
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    writeFileSync(path.join(lockDir, 'pid'), String(process.pid), { mode: 0o600 });
    return {
      release() {
        rmSync(lockDir, { recursive: true, force: true });
      },
    };
  }
  return null;
}
