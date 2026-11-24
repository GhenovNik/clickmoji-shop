// Pipeline tests with the fake docker: success, every failure path, pruning, drops,
// the lock, and what reaches docker argv and the status file.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig } from '../config.mjs';
import { LEDGER_NAME } from '../constants.mjs';
import {
  containersLeft,
  daemonLog,
  envFor,
  lockIsFree,
  removalEvents,
  spawnLockHolder,
  startLockedRun,
  NEW_NAME,
  NOW,
  listCopies,
  makeSandbox,
  readDockerLog,
  readStatus,
  runWithFake,
  seedBackups,
  syntheticDatabase,
} from './helpers.mjs';
import { EXIT, MESSAGES } from '../constants.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(25);
  }
  return false;
}

let sandbox;
let db;

beforeEach(() => {
  sandbox = makeSandbox();
  db = syntheticDatabase();
});

afterEach(() => {
  sandbox.cleanup();
});

const tempLeft = () =>
  readdirSync(sandbox.tmp).filter((name) => name.startsWith('clickmoji-backup-'));

describe('successful run', () => {
  it('publishes a complete encrypted copy, prunes to 14 and leaves no plaintext', async () => {
    const old = seedBackups(sandbox.backupDir, 100);
    const result = await runWithFake(sandbox, db);

    assert.equal(result.ok, true);
    assert.equal(result.exit, EXIT.ok);
    assert.equal(result.name, NEW_NAME);
    const copies = listCopies(sandbox.backupDir);
    assert.equal(copies.length, 14, 'exactly 14 copies remain');
    assert.ok(copies.includes(NEW_NAME));
    assert.equal(copies.filter((name) => old.includes(name)).length, 13);
    assert.equal(
      readFileSync(path.join(sandbox.backupDir, NEW_NAME), 'utf8'),
      'age-encryption.org/v1\nFAKE-CIPHERTEXT\n'
    );
    assert.deepEqual(tempLeft(), [], 'plaintext and temporary cluster removed');
  });

  it('writes one status line with date, size and verification, and no secrets', async () => {
    seedBackups(sandbox.backupDir, 3);
    await runWithFake(sandbox, db);
    const lines = readStatus(sandbox).trim().split('\n');
    assert.equal(lines.length, 1);
    const [date, outcome, detail] = lines[0].split('\t');
    assert.match(date, /^2026-11-24T12:00:00\.000Z$/);
    assert.equal(outcome, 'ok');
    assert.match(
      detail,
      /^size=\d+ verify=ok file=clickmoji-20261124T120000Z\.dump\.age prune=ok$/
    );
    assert.ok(!readStatus(sandbox).includes(db.password));
    assert.ok(!readStatus(sandbox).includes(db.host));
  });

  it('keeps the meta sidecar with counts out of the status file and next to the copy', async () => {
    await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":10,"b":20}' });
    const meta = JSON.parse(
      readFileSync(path.join(sandbox.backupDir, 'meta', `${NEW_NAME}.json`), 'utf8')
    );
    assert.deepEqual(meta.counts, { a: 10, b: 20 });
    assert.equal(meta.verify, 'ok');
    assert.ok(!readStatus(sandbox).includes('"a"'));
  });
});

describe('failure paths keep old copies and clean up', () => {
  const failures = [
    ['docker unavailable', { FAKE_DOCKER_MODE: 'docker-down' }, 'docker', EXIT.unavailable],
    [
      'image cannot be pulled or built',
      { FAKE_DOCKER_MODE: 'pull-fail' },
      'image',
      EXIT.unavailable,
    ],
    [
      'dump fails after writing partial plaintext',
      { FAKE_DOCKER_MODE: 'dump-fail' },
      'dump',
      EXIT.failed,
    ],
    [
      'restore or comparison fails (corrupt copy)',
      { FAKE_DOCKER_MODE: 'verify-fail' },
      'verify',
      EXIT.failed,
    ],
    [
      'restored identities differ from the source',
      { FAKE_RESTORED_IDENTITIES: 'a\tid text NO\nb\tid int4 NO' },
      'verify',
      EXIT.failed,
    ],
    [
      'restored migration differs from the source',
      { FAKE_RESTORED_MIGRATION: 'm_1' },
      'verify',
      EXIT.failed,
    ],
    ['encryption fails', { FAKE_DOCKER_MODE: 'encrypt-fail' }, 'encrypt', EXIT.failed],
  ];

  for (const [label, extra, key, exit] of failures) {
    it(`${label}: old copies intact, status says why, nothing left behind`, async () => {
      const old = seedBackups(sandbox.backupDir, 100);
      const result = await runWithFake(sandbox, db, extra);

      assert.equal(result.ok, false);
      assert.equal(result.exit, exit);
      assert.deepEqual(
        listCopies(sandbox.backupDir).sort(),
        [...old].sort(),
        'no copy was published or pruned'
      );
      assert.equal(existsSync(path.join(sandbox.backupDir, 'meta')), true);
      assert.deepEqual(tempLeft(), []);
      const line = readStatus(sandbox).trim().split('\t');
      assert.equal(line[1], 'failed');
      assert.equal(line[2], MESSAGES[key]);
    });
  }

  it('a failed encryption does not leave a partial published file', async () => {
    seedBackups(sandbox.backupDir, 2);
    await runWithFake(sandbox, db, { FAKE_DOCKER_MODE: 'encrypt-fail' });
    assert.ok(!listCopies(sandbox.backupDir).includes(NEW_NAME));
    assert.deepEqual(
      readdirSync(sandbox.backupDir).filter((n) => n.startsWith('.partial-')),
      []
    );
  });
});

describe('drops against the previous good copy', () => {
  it('flags a table that fell by more than 20% but still publishes the copy', async () => {
    seedBackups(sandbox.backupDir, 1, { counts: { a: 100, b: 100 } });
    const result = await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":10,"b":100}' });
    assert.equal(result.exit, EXIT.suspicious);
    assert.equal(result.verify, 'suspicious');
    assert.ok(listCopies(sandbox.backupDir).includes(NEW_NAME));
    const meta = JSON.parse(
      readFileSync(path.join(sandbox.backupDir, 'meta', `${NEW_NAME}.json`), 'utf8')
    );
    assert.deepEqual(meta.flagged, ['a']);
    assert.match(readStatus(sandbox), /\tsuspicious\t.*verify=suspicious/);
  });

  it('does not flag a fall of exactly 20%', async () => {
    seedBackups(sandbox.backupDir, 1, { counts: { a: 100 } });
    const result = await runWithFake(sandbox, db, {
      FAKE_COUNTS: '{"a":80}',
      FAKE_IDENTITIES: 'a\tid int4 NO',
    });
    assert.equal(result.verify, 'ok');
  });
});

describe('concurrency', () => {
  it('a live lock makes the second run stop without touching anything', async () => {
    const old = seedBackups(sandbox.backupDir, 5);
    mkdirSync(sandbox.backupDir, { recursive: true });
    const holder = spawnLockHolder(sandbox.backupDir, path.join(sandbox.root, 'gate'));
    assert.equal(await holder.acquired, true);
    try {
      const result = await runWithFake(sandbox, db);
      assert.equal(result.exit, EXIT.busy);
      assert.equal(result.key, 'busy');
      assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
      assert.equal(readStatus(sandbox).trim().split('\t')[2], MESSAGES.busy);
      assert.equal(readDockerLog(sandbox).length, 0, 'docker was never called');
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
  });

  it('a lock held by another process stops this run, and the next run proceeds once it is released', async () => {
    mkdirSync(sandbox.backupDir, { recursive: true });
    const gate = path.join(sandbox.root, 'gate');
    const holder = spawnLockHolder(sandbox.backupDir, gate);
    assert.equal(await holder.acquired, true);
    const busy = await runWithFake(sandbox, db);
    assert.equal(busy.key, 'busy');
    writeFileSync(gate, '');
    await holder.exited;
    const next = await runWithFake(sandbox, db);
    assert.equal(next.ok, true);
  });

  it('a lock whose owner was killed is taken over by the kernel, and the next run completes', async () => {
    mkdirSync(sandbox.backupDir, { recursive: true });
    const holder = spawnLockHolder(sandbox.backupDir, path.join(sandbox.root, 'never-opened'));
    assert.equal(await holder.acquired, true);
    holder.child.kill('SIGKILL');
    await holder.exited;
    assert.equal(await until(() => lockIsFree(sandbox.backupDir), 10_000), true, 'lock freed');
    const result = await runWithFake(sandbox, db);
    assert.equal(result.ok, true);
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'lock released by the run');
  });
});

describe('interruption stops containers before anything is removed', () => {
  it('a stop with a dump in progress removes its container, then plaintext and lock; copies intact', async () => {
    const old = seedBackups(sandbox.backupDir, 20);
    const env = envFor(sandbox, db, { FAKE_DOCKER_MODE: 'interrupt' });
    const run = startLockedRun({ backupDir: sandbox.backupDir, env, tempRoot: sandbox.tmp });
    const started = Date.now();
    while (containersLeft(sandbox).length === 0 && Date.now() - started < 15_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(containersLeft(sandbox).length, 1, 'the dump container is running');
    run.child.kill('SIGTERM');
    const result = await run.done;

    assert.equal(result.key, 'interrupted');
    assert.equal(result.exit, EXIT.interrupted);
    assert.deepEqual(containersLeft(sandbox), [], 'no container survives the stop');
    const [removal] = removalEvents(sandbox);
    assert.equal(removal.workDirExists, true, 'container removed before the plaintext directory');
    assert.equal(removal.lockHeld, true, 'container removed before the lock is released');
    assert.deepEqual(tempLeft(), [], 'temporary directory removed afterwards');
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'lock released last');
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort(), 'old copies intact');
  });

  it('a container that cannot be proven gone stays in the ledger: later runs do nothing until it is proven gone', async () => {
    const env = envFor(sandbox, db, { FAKE_DOCKER_MODE: 'interrupt', FAKE_DOCKER_RM: 'fail' });
    const run = startLockedRun({ backupDir: sandbox.backupDir, env, tempRoot: sandbox.tmp });
    const started = Date.now();
    while (containersLeft(sandbox).length === 0 && Date.now() - started < 15_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    run.child.kill('SIGTERM');
    const result = await run.done;

    assert.equal(result.ok, false);
    assert.equal(result.key, 'cleanup');
    assert.equal(containersLeft(sandbox).length, 1, 'the container identity is still known');
    assert.equal(tempLeft().length, 1, 'temporary directory kept, not deleted under a container');
    assert.equal(
      existsSync(path.join(sandbox.backupDir, LEDGER_NAME)),
      true,
      'the ledger records it'
    );
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'the lock is free; the ledger blocks');

    const runsBefore = readDockerLog(sandbox).filter((call) => call.argv[0] === 'run').length;
    const blocked = await runWithFake(sandbox, db, { FAKE_DOCKER_RM: 'fail' });
    assert.equal(blocked.key, 'cleanup');
    assert.equal(
      readDockerLog(sandbox).filter((call) => call.argv[0] === 'run').length,
      runsBefore,
      'no container is started while the ledger is not clear'
    );

    const recovered = await runWithFake(sandbox, db);
    assert.equal(recovered.ok, true, 'once the container is proven gone the run proceeds');
    assert.equal(existsSync(path.join(sandbox.backupDir, LEDGER_NAME)), false, 'ledger cleared');
  });
});

describe('the daemon keeps no container output', () => {
  it('every container runs with the log driver disabled, and a failure marker never reaches the daemon log', async () => {
    const failed = await runWithFake(sandbox, db, { FAKE_DOCKER_MODE: 'dump-fail' });
    assert.equal(failed.key, 'dump');
    const succeeded = await runWithFake(sandbox, db);
    assert.equal(succeeded.ok, true);

    const containerRuns = readDockerLog(sandbox).filter((call) => call.argv[0] === 'run');
    assert.equal(containerRuns.length, 4, 'failed dump, then dump, verify and encrypt');
    for (const call of containerRuns) {
      const i = call.argv.indexOf('--log-driver');
      assert.equal(call.argv[i + 1], 'none', 'log driver disabled for every container');
    }
    assert.equal(daemonLog(sandbox).includes(db.password), false, 'password not in daemon log');
    assert.equal(readStatus(sandbox).includes(db.password), false);
    assert.equal(readStatus(sandbox).includes('connection failed'), false);
  });
});

describe('what reaches docker', () => {
  const expectedForwarded = (db) => {
    const url = new URL(db.url);
    return {
      DATABASE_URL: db.url,
      PGHOST: url.hostname,
      PGPORT: url.port,
      PGDATABASE: 'clickmoji',
      PGUSER: 'app_user',
      PGPASSWORD: db.password,
      PGSSLMODE: 'require',
    };
  };

  it('argv never carries the address, host, user or password; values arrive by name only', async () => {
    await runWithFake(sandbox, db);
    const calls = readDockerLog(sandbox);
    assert.ok(calls.length >= 5);
    for (const call of calls) {
      const joined = call.argv.join('\n');
      assert.ok(!joined.includes(db.password), 'no password in argv');
      assert.ok(!joined.includes(db.host), 'no host in argv');
      assert.ok(!joined.includes('postgresql://'), 'no URL in argv');
      assert.ok(
        !call.argv.some((arg) => /^PG[A-Z_]*=/.test(arg)),
        'no PG variable is given a value in argv'
      );
    }
  });

  it('the source steps receive every libpq value from the environment with the expected values', async () => {
    const expected = expectedForwarded(db);
    await runWithFake(sandbox, db, { FAKE_EXPECTED_CONNECTION: JSON.stringify(expected) });
    const sourceSteps = readDockerLog(sandbox).filter((call) =>
      call.argv.some((arg) => arg === '/opt/backup/dump.sh' || arg === '/opt/backup/verify.sh')
    );
    assert.equal(sourceSteps.length, 2);
    for (const call of sourceSteps) {
      for (const name of Object.keys(expected)) {
        assert.equal(call.forwarded[name], true, `${name} forwarded by value`);
        assert.ok(call.argv.includes(name), `${name} forwarded by name`);
      }
    }
  });

  it('the encrypt and cleanup steps get no database connection', async () => {
    await runWithFake(sandbox, db);
    for (const call of readDockerLog(sandbox)) {
      if (call.argv.includes('age') || call.argv.some((arg) => arg.includes('rm -rf'))) {
        assert.deepEqual(Object.keys(call.forwarded), [], 'no PG variable forwarded');
      }
    }
  });
});

describe('temporary directories', () => {
  const tempWith = (root, { backupDir, pid, name }) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'dump.custom'), 'PLAINTEXT-LEFTOVER');
    if (backupDir !== undefined) {
      writeFileSync(
        path.join(dir, 'owner.json'),
        JSON.stringify({
          pid,
          backupKey: crypto.createHash('sha256').update(backupDir).digest('hex'),
        })
      );
    }
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(dir, old, old);
    return dir;
  };

  it('a sweep never removes another backup directory temp, an unmarked one, or a live one', async () => {
    const otherBackup = path.join(sandbox.root, 'other-backups');
    const other = tempWith(sandbox.tmp, {
      name: 'clickmoji-backup-other',
      backupDir: otherBackup,
      pid: 999_999,
    });
    const unmarked = tempWith(sandbox.tmp, { name: 'clickmoji-backup-unmarked' });
    const live = tempWith(sandbox.tmp, {
      name: 'clickmoji-backup-live',
      backupDir: sandbox.backupDir,
      pid: process.pid,
    });
    const stale = tempWith(sandbox.tmp, {
      name: 'clickmoji-backup-stale',
      backupDir: sandbox.backupDir,
      pid: 999_999,
    });
    await runWithFake(sandbox, db);
    assert.equal(existsSync(other), true, 'another backup directory is untouched');
    assert.equal(existsSync(unmarked), true, 'an unmarked directory is untouched');
    assert.equal(existsSync(live), true, 'a live owner is untouched');
    assert.equal(existsSync(stale), false, 'only a stale own directory is removed');
  });

  it('two backup directories sharing one temp root run concurrently without touching each other', async () => {
    const tmpRoot = sandbox.tmp;
    const makeConfigRun = (label) => {
      const backupDir = path.join(sandbox.root, `backups-${label}`);
      const statusFile = path.join(sandbox.root, `status-${label}.log`);
      const env = envFor({ ...sandbox, backupDir, statusFile }, db);
      return startLockedRun({ backupDir, env, tempRoot: tmpRoot }).done;
    };
    const [first, second] = await Promise.all([makeConfigRun('a'), makeConfigRun('b')]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(
      readdirSync(tmpRoot).filter((name) => name.startsWith('clickmoji-backup-')),
      [],
      'both temporary directories removed'
    );
  });

  it('a cleanup that cannot remove the plaintext fails the run, with a status line and the lock released', async () => {
    const result = await runWithFake(sandbox, db, { FAKE_DOCKER_MODE: 'cleanup-fail' });
    try {
      assert.equal(result.ok, false);
      assert.equal(result.key, 'cleanup');
      assert.equal(result.exit, EXIT.failed);
      assert.equal(await lockIsFree(sandbox.backupDir), true, 'lock released');
      const line = readStatus(sandbox).trim().split('\t');
      assert.equal(line[1], 'failed');
      assert.equal(line[2], MESSAGES.cleanup);
    } finally {
      // Restore write access so the sandbox can be deleted.
      for (const name of readdirSync(sandbox.tmp)) {
        const out = path.join(sandbox.tmp, name, 'out', 'restored');
        if (existsSync(out)) chmodSync(out, 0o755);
      }
    }
  });
});
