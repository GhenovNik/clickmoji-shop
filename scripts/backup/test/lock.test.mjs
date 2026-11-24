// Backup lock: one owner at a time (kernel flock), a stable lock file that is never renamed or
// removed, release confirmed by the helper's exit, and recovery from SIGKILL of the owner or of
// its helper. Contention uses real child processes against the same directory; a gate file keeps
// the winner holding the lock until every other process has made its attempt.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireLock } from '../lock.mjs';
import { LOCK_NAME } from '../constants.mjs';
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

  it('a second acquisition in the same process is refused until the first is released', async () => {
    const first = await acquireLock(sandbox.backupDir);
    assert.ok(first, 'first acquisition succeeds');
    assert.equal(await acquireLock(sandbox.backupDir), null, 'second acquisition refused');
    await first.release();
    const again = await acquireLock(sandbox.backupDir);
    assert.ok(again, 'free again after release');
    await again.release();
  });
});

describe('the lock file is stable', () => {
  it('is created once and never renamed or removed: the same inode across acquisitions', async () => {
    const first = await acquireLock(sandbox.backupDir);
    const inode = statSync(LOCK(sandbox.backupDir)).ino;
    await first.release();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const lock = await acquireLock(sandbox.backupDir);
      assert.ok(lock, `cycle ${cycle} acquires`);
      assert.equal(statSync(LOCK(sandbox.backupDir)).ino, inode, 'same file');
      await lock.release();
    }
    assert.deepEqual(readdirSync(sandbox.backupDir).filter((name) => name.startsWith(LOCK_NAME)), [
      LOCK_NAME,
    ]);
  });

  it('a lock file with junk in it does not block: only the kernel lock decides', async () => {
    writeFileSync(LOCK(sandbox.backupDir), 'not json');
    const lock = await acquireLock(sandbox.backupDir);
    assert.ok(lock, 'acquired');
    await lock.release();
  });
});

describe('release', () => {
  it('resolves only after the helper has exited, so the next acquisition succeeds at once', async () => {
    const lock = await acquireLock(sandbox.backupDir);
    await lock.release();
    assert.equal(lock.held(), false);
    assert.equal(await lock.confirm(), false, 'a released lock is not confirmed');
    const next = await acquireLock(sandbox.backupDir);
    assert.ok(next, 'free immediately');
    await next.release();
  });

  it('a second release does nothing', async () => {
    const lock = await acquireLock(sandbox.backupDir);
    await lock.release();
    await lock.release();
    assert.equal(lock.held(), false);
  });

  it('release does not report a loss', async () => {
    const lock = await acquireLock(sandbox.backupDir);
    let lost = false;
    lock.onLost(() => {
      lost = true;
    });
    await lock.release();
    await sleep(50);
    assert.equal(lost, false);
  });
});

describe('crash safety', () => {
  it('SIGKILL of the owner process frees the lock for the next process', async () => {
    const gate = path.join(sandbox.root, 'never-opened');
    const holder = spawnLockHolder(sandbox.backupDir, gate);
    assert.equal(await holder.acquired, true);
    assert.equal(await lockIsFree(sandbox.backupDir), false, 'held by the live owner');

    holder.child.kill('SIGKILL');
    await holder.exited;
    assert.equal(
      await until(() => lockIsFree(sandbox.backupDir), 10_000),
      true,
      'freed by the kernel when the owner died'
    );
  });

  it('SIGKILL of the helper is detected: the owner loses the lock, confirm() is false, onLost fires', async () => {
    const lock = await acquireLock(sandbox.backupDir);
    const lostEvent = new Promise((resolve) => lock.onLost(resolve));
    process.kill(lock.helperPid, 'SIGKILL');
    await lostEvent;
    assert.equal(lock.held(), false, 'the owner no longer holds the lock');
    assert.equal(await lock.confirm(), false, 'confirmation is refused');
    await lock.release();
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'the lock is free');
  });

  it('a live owner is confirmed, and keeps the lock until it releases', async () => {
    const lock = await acquireLock(sandbox.backupDir);
    assert.equal(await lock.confirm(), true);
    assert.equal(await lockIsFree(sandbox.backupDir), false);
    await lock.release();
  });

  it('a lock held by a process that is still alive is never taken, however old its record looks', async () => {
    writeFileSync(LOCK(sandbox.backupDir), JSON.stringify({ pid: 1, token: 'ancient' }));
    const gate = path.join(sandbox.root, 'never-opened');
    const holder = spawnLockHolder(sandbox.backupDir, gate);
    assert.equal(await holder.acquired, true);
    assert.equal(await acquireLock(sandbox.backupDir), null, 'refused');
    holder.child.kill('SIGKILL');
    await holder.exited;
  });
});
