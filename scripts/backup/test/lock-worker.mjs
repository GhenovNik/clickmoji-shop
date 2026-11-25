// Child process for the lock tests. It runs as a lock writer (started through launchLocked, so the
// lock is the descriptor it inherited), reports its state as one JSON line, then holds until the
// gate file exists or it is killed. Modes:
//   hold          report that it holds the lock (default)
//   child-sees-lock  report whether a child process it starts can see the lock descriptor
//   release-early    release the lock at once, then keep running
//   with-child    start a long-lived child process of its own and report its pid
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { heldLock } from '../lock.mjs';

const [, , backupDir, gate, mode = 'hold'] = process.argv;
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lock = heldLock(backupDir, process.env);
if (!lock) {
  report({ acquired: false });
  process.exit(2);
}

if (mode === 'release-early') {
  lock.release();
  report({ acquired: true, held: lock.held() });
} else if (mode === 'child-sees-lock') {
  // `:` only duplicates the descriptor, so a visible lock file is not written to.
  const probe = spawnSync(
    '/bin/sh',
    ['-c', 'if (: >&"$BACKUP_LOCK_FD") 2>/dev/null; then echo open; else echo closed; fi'],
    { encoding: 'utf8' }
  );
  report({ acquired: true, childSeesLock: probe.stdout.trim() === 'open' });
} else if (mode === 'with-child') {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  report({ acquired: true, childPid: child.pid });
} else {
  report({ acquired: true, held: lock.held() });
}

while (!existsSync(gate)) await sleep(10);
lock.release();
process.exit(0);
