// Backup lock: a writer holds the kernel lock through the descriptor the launcher hands it, for its
// whole critical section. Contenders are refused; the lock is freed when the writer exits or is
// SIGKILLed, and not before (a child process of the writer does not keep it). Contention uses real
// processes against the same directory; a gate file keeps the winner holding the lock until the
// other attempts are made.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LOCK_NAME } from '../constants.mjs';
import { heldLock, launchLocked, LAUNCH_FAILED, LOCK_FD_ENV } from '../lock.mjs';
import {
  listCopies,
  LOCK,
  lockIsFree,
  makeSandbox,
  seedBackups,
  spawnLockHolder,
} from './helpers.mjs';

let sandbox;

beforeEach(() => {
  sandbox = makeSandbox();
  mkdirSync(sandbox.backupDir, { recursive: true });
});

afterEach(() => {
  sandbox.cleanup();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A pid that belonged to a process which has exited.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid;
}

async function until(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(25);
  }
  return false;
}

const exitCodeOf = (child) => new Promise((resolve) => child.on('close', (code) => resolve(code)));

describe('one owner at a time', () => {
  it('four processes contend for the lock while a dead owner record is on disk: exactly one acquires, the others are refused, copies unchanged', async () => {
    const old = seedBackups(sandbox.backupDir, 14);
    const bytesBefore = Object.fromEntries(
      old.map((name) => [name, readFileSync(path.join(sandbox.backupDir, name))])
    );
    // A record left behind by an earlier version. The kernel lock does not read it.
    writeFileSync(LOCK(sandbox.backupDir), JSON.stringify({ pid: await deadPid(), token: 'old' }));
    const gate = path.join(sandbox.root, 'gate');

    const holders = Array.from({ length: 4 }, () => spawnLockHolder(sandbox.backupDir, gate));
    const acquired = await Promise.all(holders.map((holder) => holder.acquired));
    assert.equal(acquired.filter(Boolean).length, 1, 'exactly one owner');
    assert.equal(acquired.filter((value) => !value).length, 3, 'the others are refused');
    assert.equal(await lockIsFree(sandbox.backupDir), false, 'the owner still holds the lock');

    writeFileSync(gate, '');
    await Promise.all(holders.map((holder) => holder.exited));
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'the owner released its lock');
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort(), 'no copy added or removed');
    for (const name of old) {
      assert.deepEqual(
        readFileSync(path.join(sandbox.backupDir, name)),
        bytesBefore[name],
        `${name} unchanged`
      );
    }
    assert.deepEqual(
      readdirSync(sandbox.backupDir).filter((name) => name.startsWith(LOCK_NAME)),
      [LOCK_NAME],
      'only the stable lock file is left'
    );
  });

  it('a writer holds the lock for its whole critical section: contenders are refused until it exits', async () => {
    const gate = path.join(sandbox.root, 'gate');
    const holder = spawnLockHolder(sandbox.backupDir, gate);
    assert.equal(await holder.acquired, true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(await lockIsFree(sandbox.backupDir), false, `attempt ${attempt} refused`);
      await sleep(50);
    }
    writeFileSync(gate, '');
    await holder.exited;
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'free once the writer has exited');
  });
});

describe('the descriptor the writer receives', () => {
  it('the writer is given the locked descriptor: it reports holding the lock', async () => {
    const holder = spawnLockHolder(sandbox.backupDir, path.join(sandbox.root, 'gate'));
    const line = await holder.report;
    assert.equal(line.acquired, true);
    assert.equal(line.held, true);
    holder.child.kill('SIGKILL');
    await holder.exited;
  });

  it('heldLock refuses a missing, malformed or low descriptor, and one that is not the lock file', () => {
    assert.equal(heldLock(sandbox.backupDir, {}), null, 'no descriptor');
    assert.equal(heldLock(sandbox.backupDir, { [LOCK_FD_ENV]: 'x' }), null, 'not a number');
    assert.equal(heldLock(sandbox.backupDir, { [LOCK_FD_ENV]: '2' }), null, 'a standard stream');
    const other = path.join(sandbox.root, 'other');
    writeFileSync(other, '');
    writeFileSync(LOCK(sandbox.backupDir), '');
    const fd = openSync(other, 'r');
    try {
      assert.equal(heldLock(sandbox.backupDir, { [LOCK_FD_ENV]: String(fd) }), null, 'not the lock');
    } finally {
      closeSync(fd);
    }
  });

  it('the launcher refuses a lock file that is a symbolic link, and runs nothing', async () => {
    const target = path.join(sandbox.root, 'target');
    const marker = path.join(sandbox.root, 'ran');
    writeFileSync(target, 'keep');
    symlinkSync(target, LOCK(sandbox.backupDir));
    const child = launchLocked(
      sandbox.backupDir,
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`],
      { stdio: 'ignore' }
    );
    assert.equal(await exitCodeOf(child), LAUNCH_FAILED);
    assert.equal(existsSync(marker), false, 'the command never ran');
    assert.equal(readFileSync(target, 'utf8'), 'keep', 'the link target is untouched');
  });

  it('a child process of the writer does not receive the lock descriptor', async () => {
    const holder = spawnLockHolder(sandbox.backupDir, path.join(sandbox.root, 'gate'), 'child-sees-lock');
    const line = await holder.report;
    assert.equal(line.acquired, true);
    assert.equal(line.childSeesLock, false, 'the child cannot see the descriptor');
    holder.child.kill('SIGKILL');
    await holder.exited;
  });
});

describe('release and crash safety', () => {
  it('SIGKILL of the writer frees the lock for the next process', async () => {
    const gate = path.join(sandbox.root, 'never-opened');
    const holder = spawnLockHolder(sandbox.backupDir, gate);
    assert.equal(await holder.acquired, true);
    assert.equal(await lockIsFree(sandbox.backupDir), false, 'held by the live writer');

    holder.child.kill('SIGKILL');
    await holder.exited;
    assert.equal(
      await until(() => lockIsFree(sandbox.backupDir), 10_000),
      true,
      'freed by the kernel when the writer died'
    );
  });

  it('SIGKILL of the writer frees the lock even while its child process is still alive', async () => {
    const holder = spawnLockHolder(sandbox.backupDir, path.join(sandbox.root, 'never-opened'), 'with-child');
    const line = await holder.report;
    assert.equal(line.acquired, true);
    holder.child.kill('SIGKILL');
    await holder.exited;
    assert.equal(
      await until(() => lockIsFree(sandbox.backupDir), 10_000),
      true,
      'the child does not keep the lock'
    );
    process.kill(line.childPid, 'SIGKILL'); // the orphaned child is still running; stop it
  });

  it('a writer that releases its lock frees it at once, while it keeps running', async () => {
    const gate = path.join(sandbox.root, 'gate');
    const holder = spawnLockHolder(sandbox.backupDir, gate, 'release-early');
    const line = await holder.report;
    assert.equal(line.held, false);
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'free while the writer still lives');
    writeFileSync(gate, '');
    await holder.exited;
  });

  it('a live writer keeps the lock; it is never taken, however old its record looks', async () => {
    writeFileSync(LOCK(sandbox.backupDir), JSON.stringify({ pid: 1, token: 'ancient' }));
    const holder = spawnLockHolder(sandbox.backupDir, path.join(sandbox.root, 'never-opened'));
    assert.equal(await holder.acquired, true);
    assert.equal(await lockIsFree(sandbox.backupDir), false, 'refused');
    holder.child.kill('SIGKILL');
    await holder.exited;
  });
});

describe('the lock file is stable', () => {
  it('is created once and never renamed or removed: the same inode across acquisitions', async () => {
    assert.equal(await lockIsFree(sandbox.backupDir), true);
    const inode = statSync(LOCK(sandbox.backupDir)).ino;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      assert.equal(await lockIsFree(sandbox.backupDir), true, `cycle ${cycle} acquires`);
      assert.equal(statSync(LOCK(sandbox.backupDir)).ino, inode, 'same file');
    }
    assert.deepEqual(readdirSync(sandbox.backupDir).filter((name) => name.startsWith(LOCK_NAME)), [
      LOCK_NAME,
    ]);
  });

  it('a lock file with junk in it does not block: only the kernel lock decides', async () => {
    writeFileSync(LOCK(sandbox.backupDir), 'not json');
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'acquired');
  });
});
