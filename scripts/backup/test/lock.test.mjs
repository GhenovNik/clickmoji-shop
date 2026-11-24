// Backup lock: one owner at a time, stale recovery, owner-bound release, abandoned acquisition.
// The contention test runs real child processes against the same directory; a gate file keeps
// the winner holding the lock until every other process has made its attempt, so the outcome
// does not depend on scheduling.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireLock } from '../lock.mjs';
import { LOCK_NAME } from '../constants.mjs';
import { HERE, LOCK, listCopies, makeSandbox, seedBackups, writeLock } from './helpers.mjs';

const WORKER = path.join(HERE, 'lock-worker.mjs');

let sandbox;

beforeEach(() => {
  sandbox = makeSandbox();
  mkdirSync(sandbox.backupDir, { recursive: true });
});

afterEach(() => {
  sandbox.cleanup();
});

// A pid that belonged to a process which has exited.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid;
}

// Reads one JSON line per child from its stdout, resolving with the first `count` lines.
function firstLines(child, count) {
  return new Promise((resolve) => {
    const lines = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        lines.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      if (lines.length >= count) resolve(lines.slice(0, count));
    });
  });
}

describe('one owner at a time', () => {
  it('four processes contend for a stale lock: exactly one acquires, the others are refused, copies unchanged', async () => {
    const old = seedBackups(sandbox.backupDir, 14);
    const bytesBefore = Object.fromEntries(
      old.map((name) => [name, readFileSync(path.join(sandbox.backupDir, name))])
    );
    writeLock(sandbox.backupDir, { pid: await deadPid() });
    const gate = path.join(sandbox.root, 'gate');

    const children = Array.from({ length: 4 }, () =>
      spawn(process.execPath, [WORKER, sandbox.backupDir, gate], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
    );
    const exits = children.map((child) => new Promise((resolve) => child.on('close', resolve)));
    const attempts = await Promise.all(children.map((child) => firstLines(child, 1)));
    const outcomes = attempts.map(([line]) => line);

    assert.equal(outcomes.filter((line) => line.acquired).length, 1, 'exactly one owner');
    assert.equal(outcomes.filter((line) => !line.acquired).length, 3, 'the others are refused');
    const winner = outcomes.find((line) => line.acquired);
    assert.equal(
      JSON.parse(readFileSync(LOCK(sandbox.backupDir), 'utf8')).pid,
      winner.pid,
      'the record names the owner'
    );

    writeFileSync(gate, '');
    await Promise.all(exits);
    assert.equal(existsSync(LOCK(sandbox.backupDir)), false, 'the owner released its lock');
    assert.deepEqual(
      listCopies(sandbox.backupDir).sort(),
      [...old].sort(),
      'no copy added or removed'
    );
    for (const name of old) {
      assert.deepEqual(
        readFileSync(path.join(sandbox.backupDir, name)),
        bytesBefore[name],
        `${name} unchanged`
      );
    }
    assert.deepEqual(
      readdirSync(sandbox.backupDir).filter((name) => name.startsWith(LOCK_NAME)),
      [],
      'no lock leftovers'
    );
  });

  it('a lock held by a live process refuses a second acquisition in the same process too', () => {
    const first = acquireLock(sandbox.backupDir);
    assert.ok(first, 'first acquisition succeeds');
    assert.equal(acquireLock(sandbox.backupDir), null, 'second acquisition refused');
    first.release();
    assert.ok(acquireLock(sandbox.backupDir), 'free again after release');
  });
});

describe('owner-bound release', () => {
  it('a handle whose record was replaced cannot remove the new owner lock', () => {
    const mine = acquireLock(sandbox.backupDir);
    const replacedWith = writeLock(sandbox.backupDir, { pid: process.pid });
    assert.equal(mine.held(), false, 'the handle no longer holds the lock');
    mine.release();
    const record = JSON.parse(readFileSync(LOCK(sandbox.backupDir), 'utf8'));
    assert.equal(record.token, replacedWith, 'the other owner record is still there');
  });
});

describe('stale and abandoned state', () => {
  it('a lock whose owner is gone is taken over, and the new record names this process', async () => {
    writeLock(sandbox.backupDir, { pid: await deadPid() });
    const lock = acquireLock(sandbox.backupDir);
    assert.ok(lock, 'taken over');
    assert.equal(JSON.parse(readFileSync(LOCK(sandbox.backupDir), 'utf8')).pid, process.pid);
    assert.equal(lock.held(), true);
    lock.release();
  });

  it('an unreadable lock record is treated as stale rather than blocking the directory forever', () => {
    mkdirSync(sandbox.backupDir, { recursive: true });
    writeFileSync(LOCK(sandbox.backupDir), 'not json');
    assert.ok(acquireLock(sandbox.backupDir), 'taken over');
  });

  it('an acquisition abandoned before its link leaves nothing that blocks the next run', async () => {
    mkdirSync(sandbox.backupDir, { recursive: true });
    const tmp = path.join(sandbox.backupDir, `${LOCK_NAME}.tmp-${await deadPid()}-abc`);
    writeFileSync(
      tmp,
      JSON.stringify({ pid: Number(tmp.split('tmp-')[1].split('-')[0]), token: 'abc' })
    );
    const lock = acquireLock(sandbox.backupDir);
    assert.ok(lock, 'acquired without a lock file ever existing');
    assert.equal(existsSync(tmp), false, 'the abandoned record is swept');
    lock.release();
  });

  it('a renamed-away stale lock left by a crashed takeover is swept', async () => {
    mkdirSync(sandbox.backupDir, { recursive: true });
    const reap = path.join(sandbox.backupDir, `${LOCK_NAME}.reap-${await deadPid()}-x`);
    writeFileSync(
      reap,
      JSON.stringify({ pid: Number(reap.split('reap-')[1].split('-')[0]), token: 'x' })
    );
    const lock = acquireLock(sandbox.backupDir);
    assert.ok(lock);
    assert.equal(existsSync(reap), false);
    lock.release();
  });
});
