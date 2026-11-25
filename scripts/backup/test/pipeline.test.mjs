// Pipeline tests with the fake docker: success, every failure path, pruning, drops,
// the lock, and what reaches docker argv and the status file.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { cleanupArgs } from '../docker.mjs';
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
  runCli,
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
    assert.equal(result.key, 'containers');
    assert.equal(containersLeft(sandbox).length, 1, 'the container identity is still known');
    assert.equal(tempLeft().length, 1, 'temporary directory kept, not deleted under a container');
    assert.equal(
      existsSync(path.join(sandbox.backupDir, LEDGER_NAME)),
      true,
      'the ledger records it'
    );
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'the lock is free; the ledger blocks');

    const runsBefore = readDockerLog(sandbox).filter((call) => call.argv[0] === 'create').length;
    const blocked = await runWithFake(sandbox, db, { FAKE_DOCKER_RM: 'fail' });
    assert.equal(blocked.key, 'containers');
    assert.equal(
      readDockerLog(sandbox).filter((call) => call.argv[0] === 'create').length,
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

    const containerRuns = readDockerLog(sandbox).filter((call) => call.argv[0] === 'create');
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

// Makes every leftover scratch tree removable again, so the sandbox can be deleted.
function unlockTemp() {
  for (const name of readdirSync(sandbox.tmp)) {
    const out = path.join(sandbox.tmp, name, 'out', 'restored');
    if (existsSync(out)) chmodSync(out, 0o755);
  }
}

const LATER = new Date(NOW.getTime() + 86_400_000);
const ledgerPath = () => path.join(sandbox.backupDir, LEDGER_NAME);
const ledgerNames = () =>
  existsSync(ledgerPath()) ? JSON.parse(readFileSync(ledgerPath(), 'utf8')).containers : [];
const runCalls = () => readDockerLog(sandbox).filter((call) => call.argv[0] === 'create');
const isFallback = (call) => call.argv.some((arg) => arg.includes('rm -rf'));
const nameOf = (call) => call.argv[call.argv.indexOf('--name') + 1];

describe('a zero exit does not prove that the container is gone (B1a)', () => {
  it('an unconfirmed daemon after a zero-exit dump: nothing is verified, published or pruned', async () => {
    const old = seedBackups(sandbox.backupDir, 100);
    const before = old.map((name) => readFileSync(path.join(sandbox.backupDir, name), 'utf8'));
    const result = await runWithFake(sandbox, db, { FAKE_DOCKER_PS: 'fail' });

    assert.equal(result.ok, false);
    assert.equal(result.key, 'containers');
    assert.equal(result.exit, EXIT.failed);
    assert.equal(
      runCalls().some((call) => call.argv.includes('/opt/backup/verify.sh')),
      false,
      'no verification after an unproven dump'
    );
    assert.equal(
      runCalls().some((call) => call.argv.includes('age')),
      false,
      'no encryption after an unproven dump'
    );
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort(), 'nothing pruned');
    assert.ok(!listCopies(sandbox.backupDir).includes(NEW_NAME), 'nothing published');
    old.forEach((name, i) =>
      assert.equal(readFileSync(path.join(sandbox.backupDir, name), 'utf8'), before[i])
    );
    assert.equal(ledgerNames().length, 1, 'the ledger keeps the dump container');
    assert.equal(readStatus(sandbox).trim().split('\t')[2], MESSAGES.containers);
  });

  it('the next run proves that container gone before anything else, then completes', async () => {
    seedBackups(sandbox.backupDir, 2);
    await runWithFake(sandbox, db, { FAKE_DOCKER_PS: 'fail' });
    const [leftover] = ledgerNames();
    assert.ok(leftover, 'a name is recorded');

    const from = readDockerLog(sandbox).length;
    const next = await runWithFake(sandbox, db);
    assert.equal(next.ok, true);
    const later = readDockerLog(sandbox).slice(from);
    const removal = later.findIndex(
      (call) => call.argv[0] === 'rm' && call.argv.includes(leftover)
    );
    const firstRun = later.findIndex((call) => call.argv[0] === 'create');
    assert.ok(
      removal >= 0 && removal < firstRun,
      'the leftover is removed before any container starts'
    );
    assert.deepEqual(ledgerNames(), [], 'ledger cleared once absence is proven');
  });
});

describe('the cleanup fallback is a tracked container too (B1b)', () => {
  it('is recorded in the ledger before it starts and proven gone afterwards', async () => {
    try {
      const result = await runWithFake(sandbox, db, { FAKE_DOCKER_MODE: 'cleanup-fail' });
      assert.equal(result.key, 'cleanup', 'the host still cannot remove the directory');
      const [fallback] = runCalls().filter(isFallback);
      assert.ok(fallback, 'the fallback ran');
      assert.match(nameOf(fallback), /^clickmoji-backup-cleanup-/);
      assert.equal(fallback.ledgerHas, true, 'recorded in the ledger before it started');
      assert.deepEqual(containersLeft(sandbox), [], 'no container survives');
      assert.deepEqual(ledgerNames(), [], 'ledger cleared once absence is proven');
      assert.equal(tempLeft().length, 1, 'the directory is kept, not deleted under a container');
    } finally {
      unlockTemp();
    }
  });

  it('a writer killed during the fallback leaves its container recorded; the next writer removes it first', async () => {
    try {
      const run = startLockedRun({
        backupDir: sandbox.backupDir,
        env: envFor(sandbox, db, { FAKE_DOCKER_MODE: 'cleanup-hang' }),
        tempRoot: sandbox.tmp,
      });
      const fallbackName = () =>
        containersLeft(sandbox).find((name) => name.startsWith('clickmoji-backup-cleanup-'));
      assert.ok(await until(() => fallbackName(), 15_000), 'the fallback container is running');
      run.child.kill('SIGKILL');
      assert.equal(await run.done, null, 'the writer died without a result');
      const leftover = fallbackName();
      assert.deepEqual(ledgerNames(), [leftover], 'the fallback container is recorded');
      unlockTemp(); // the host can delete the directory again; a stuck cleanup would be fail-closed

      const from = readDockerLog(sandbox).length;
      const next = await runWithFake(sandbox, db, {}, LATER);
      assert.equal(next.ok, true, 'the next run completes once the leftover is gone');
      const later = readDockerLog(sandbox).slice(from);
      const removal = later.findIndex(
        (call) => call.argv[0] === 'rm' && call.argv.includes(leftover)
      );
      const firstRun = later.findIndex((call) => call.argv[0] === 'create');
      assert.ok(removal >= 0 && removal < firstRun, 'removed before any container starts');
      assert.deepEqual(containersLeft(sandbox), []);
      assert.deepEqual(ledgerNames(), []);
    } finally {
      unlockTemp();
    }
  });

  it('a stop during the fallback stops its container too, and the lock is released after it is gone', async () => {
    try {
      const run = startLockedRun({
        backupDir: sandbox.backupDir,
        env: envFor(sandbox, db, { FAKE_DOCKER_MODE: 'cleanup-hang' }),
        tempRoot: sandbox.tmp,
      });
      assert.ok(
        await until(
          () =>
            containersLeft(sandbox).some((name) => name.startsWith('clickmoji-backup-cleanup-')),
          15_000
        ),
        'the fallback container is running'
      );
      run.child.kill('SIGTERM');
      const result = await run.done;
      assert.equal(result.key, 'cleanup', 'the copy was published; its plaintext directory stayed');
      assert.deepEqual(containersLeft(sandbox), [], 'the fallback container is gone');
      assert.deepEqual(ledgerNames(), [], 'ledger cleared');
      assert.equal(await lockIsFree(sandbox.backupDir), true, 'lock released');
    } finally {
      unlockTemp();
    }
  });

  it('every container of a full run is in the ledger when it starts', async () => {
    await runWithFake(sandbox, db);
    const starts = runCalls().filter((call) => call.argv.includes('--name'));
    assert.equal(starts.length, 3, 'dump, verify and encrypt');
    for (const call of starts) assert.equal(call.ledgerHas, true, nameOf(call));
  });
});

describe('the status line can fail after the copy is saved', () => {
  it('a saved copy keeps its bytes, exits with the status code, and says the status is missing', async () => {
    const old = seedBackups(sandbox.backupDir, 3);
    const result = await runWithFake(sandbox, db, { FAKE_SWAP_STATUS: sandbox.statusFile });
    assert.equal(result.ok, true);
    assert.equal(result.saved, true);
    assert.equal(result.statusWritten, false);
    assert.equal(result.exit, EXIT.statusFailed);
    assert.ok(listCopies(sandbox.backupDir).includes(NEW_NAME), 'the copy is there');
    assert.deepEqual(
      listCopies(sandbox.backupDir)
        .filter((name) => old.includes(name))
        .sort(),
      [...old].sort(),
      'the copy is saved; retention keeps the three old copies'
    );
  });

  it('without a saved copy the failure code stays, and the status is reported missing', async () => {
    const result = await runWithFake(sandbox, db, {
      FAKE_SWAP_STATUS: sandbox.statusFile,
      FAKE_DOCKER_MODE: 'dump-fail',
    });
    assert.equal(result.saved, false);
    assert.equal(result.statusWritten, false);
    assert.equal(result.exit, EXIT.failed);
  });

  it('the CLI prints the distinction, exits 5 and prints no secret', async () => {
    const result = await runCli(envFor(sandbox, db, { FAKE_SWAP_STATUS: sandbox.statusFile }));
    assert.equal(result.code, EXIT.statusFailed);
    assert.match(result.stdout, /^backup: ok clickmoji-/m);
    assert.ok(result.stdout.includes(`backup: ${MESSAGES.statusSaved}`));
    assert.equal(`${result.stdout}${result.stderr}`.includes(db.password), false);
    assert.equal(
      listCopies(sandbox.backupDir).length,
      1,
      'the copy is there (the CLI uses the real clock)'
    );
  });
});

// A directory a killed run left behind: its marker names this backup directory and a process that
// has exited, and its plaintext is partly in a read-only subdirectory the host cannot delete.
function plantStale({ locked = true } = {}) {
  const config = loadConfig(envFor(sandbox, db));
  const dir = mkdtempSync(path.join(sandbox.tmp, 'clickmoji-backup-'));
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(
    path.join(dir, 'owner.json'),
    JSON.stringify({
      pid: dead,
      backupKey: crypto.createHash('sha256').update(config.backupDir).digest('hex'),
    })
  );
  writeFileSync(path.join(dir, 'dump.custom'), 'PLAINTEXT-OLD');
  const restored = path.join(dir, 'out', 'restored');
  mkdirSync(restored, { recursive: true });
  writeFileSync(path.join(restored, 'counts.tsv'), 'a\t1\n');
  if (locked) chmodSync(restored, 0o555);
  return dir;
}

const runCallsFrom = (from) =>
  readDockerLog(sandbox)
    .slice(from)
    .filter((call) => call.argv[0] === 'create');

describe('stale scratch from a killed run is recovered, or the run fails closed (B1b)', () => {
  const failing = { FAKE_DOCKER_MODE: 'cleanup-fail' };

  it('host deletion fails and the fallback is unconfirmed: no dump, publish or prune; the marker stays', async () => {
    try {
      const old = seedBackups(sandbox.backupDir, 100);
      const before = old.map((name) => readFileSync(path.join(sandbox.backupDir, name), 'utf8'));
      const stale = plantStale();
      const env = { ...failing, FAKE_DOCKER_PS: 'fail-cleanup' };

      const first = await runWithFake(sandbox, db, env);
      assert.equal(first.ok, false);
      assert.equal(first.exit, EXIT.failed);
      assert.ok(
        runCalls().length > 0 && runCalls().every(isFallback),
        'only the cleanup fallback ran'
      );
      assert.ok(existsSync(path.join(stale, 'owner.json')), 'the marker survives');
      assert.ok(existsSync(path.join(stale, 'out', 'restored', 'counts.tsv')), 'plaintext kept');
      assert.equal(ledgerNames().length, 1, 'the unconfirmed fallback stays in the ledger');
      assert.ok(!listCopies(sandbox.backupDir).includes(NEW_NAME), 'nothing published');
      assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort(), 'nothing pruned');
      old.forEach((name, i) =>
        assert.equal(readFileSync(path.join(sandbox.backupDir, name), 'utf8'), before[i])
      );

      const from = readDockerLog(sandbox).length;
      const again = await runWithFake(sandbox, db, env);
      assert.equal(again.ok, false, 'a repeated run fails the same way');
      assert.deepEqual(runCallsFrom(from), [], 'no container starts on the repeated run');
      assert.ok(existsSync(path.join(stale, 'owner.json')), 'the marker survives repeated failure');
      assert.ok(!listCopies(sandbox.backupDir).includes(NEW_NAME), 'still nothing published');
      old.forEach((name, i) =>
        assert.equal(readFileSync(path.join(sandbox.backupDir, name), 'utf8'), before[i])
      );
    } finally {
      unlockTemp();
    }
  });

  it('host deletion fails after a proven fallback: fails closed, keeps the marker, and recovers once the directory can be removed', async () => {
    try {
      const old = seedBackups(sandbox.backupDir, 100);
      const before = old.map((name) => readFileSync(path.join(sandbox.backupDir, name), 'utf8'));
      const stale = plantStale();

      const first = await runWithFake(sandbox, db, failing);
      assert.equal(first.ok, false);
      assert.equal(first.key, 'cleanup');
      assert.equal(first.exit, EXIT.failed);
      assert.ok(runCalls().every(isFallback), 'only the cleanup fallback ran');
      assert.deepEqual(containersLeft(sandbox), [], 'the fallback is proven gone');
      assert.deepEqual(ledgerNames(), []);
      assert.ok(
        existsSync(path.join(stale, 'owner.json')),
        'partial host deletion keeps the marker'
      );
      assert.ok(existsSync(path.join(stale, 'out', 'restored', 'counts.tsv')));
      assert.ok(!listCopies(sandbox.backupDir).includes(NEW_NAME), 'nothing published');
      assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort(), 'nothing pruned');

      const from = readDockerLog(sandbox).length;
      const again = await runWithFake(sandbox, db, failing);
      assert.equal(again.key, 'cleanup', 'the repeated failure is the same');
      assert.ok(runCallsFrom(from).every(isFallback), 'no dump, verify or encrypt on repeat');
      assert.ok(existsSync(path.join(stale, 'owner.json')), 'the marker survives repeated failure');
      assert.ok(!listCopies(sandbox.backupDir).includes(NEW_NAME));
      old.forEach((name, i) =>
        assert.equal(readFileSync(path.join(sandbox.backupDir, name), 'utf8'), before[i])
      );

      unlockTemp();
      const healed = await runWithFake(sandbox, db);
      assert.equal(healed.ok, true, 'the next run completes once the directory is removable');
      assert.equal(existsSync(stale), false, 'the stale directory is gone');
      assert.ok(listCopies(sandbox.backupDir).includes(NEW_NAME));
    } finally {
      unlockTemp();
    }
  });

  it('the in-image cleanup never removes the ownership marker, whatever it finds', () => {
    const dir = mkdtempSync(path.join(sandbox.tmp, 'clickmoji-backup-'));
    writeFileSync(path.join(dir, 'owner.json'), '{}');
    writeFileSync(path.join(dir, 'dump.custom'), 'PLAINTEXT');
    mkdirSync(path.join(dir, '.hidden'));
    writeFileSync(path.join(dir, '.hidden', 'file'), 'PLAINTEXT');
    const script = cleanupArgs({ name: 'n', workDir: dir }).at(-1).replaceAll('/work', dir);
    const run = spawnSync('/bin/sh', ['-c', script], { stdio: 'ignore' });
    assert.equal(run.status, 0);
    assert.deepEqual(readdirSync(dir), ['owner.json']);
  });
});

// Ledger entries as the file holds them: [{ name, state }]. A name without a state is pending.
const ledgerEntries = () => {
  if (!existsSync(ledgerPath())) return [];
  const body = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
  return body.containers.map((name) => ({ name, state: body.states?.[name] ?? 'pending' }));
};
const callsFrom = (from) => readDockerLog(sandbox).slice(from);
const startsOrCreates = (calls) =>
  calls.filter((call) => call.argv[0] === 'create' || call.argv[0] === 'start');
const waitForCreate = () =>
  until(() => readDockerLog(sandbox).some((call) => call.argv[0] === 'create'), 15_000);

describe('a create whose answer is pending is never cleared by an empty listing (B1, round 6)', () => {
  for (const failure of ['signal', 'disconnect']) {
    it(
      `a late create after ${failure} stays pending until it is seen and removed`,
      { timeout: 120_000 },
      async () => {
        seedBackups(sandbox.backupDir, 2);
        const old = listCopies(sandbox.backupDir);
        const gate = path.join(sandbox.root, 'daemon-create.gate');
        const env = envFor(sandbox, db, {
          FAKE_DOCKER_LATE_CREATE: gate,
          FAKE_DOCKER_CREATE: failure,
        });

        // The create client is sent and never answers. The run is stopped while the create is in flight.
        const run = startLockedRun({ backupDir: sandbox.backupDir, env, tempRoot: sandbox.tmp });
        assert.equal(await waitForCreate(), true, 'the dump create was sent');
        if (failure === 'signal') run.child.kill('SIGTERM');
        const result = await run.done;
        assert.equal(result.ok, false);
        assert.equal(result.key, 'containers');

        // The shutdown listed the name, found nothing, and must not have cleared it.
        const [pending] = ledgerEntries();
        assert.equal(ledgerEntries().length, 1);
        assert.equal(pending.state, 'pending', 'an empty listing does not settle a pending create');
        assert.deepEqual(containersLeft(sandbox), [], 'the create has not landed');
        assert.equal(tempLeft().length, 1, 'scratch kept: the container may still be created');
        assert.equal(startsOrCreates(readDockerLog(sandbox)).length, 1, 'only the create was sent');
        assert.equal(
          await lockIsFree(sandbox.backupDir),
          true,
          'the lock is free; the ledger blocks'
        );

        // The next writer, while the create is still unanswered, starts nothing and publishes nothing.
        const before = readDockerLog(sandbox).length;
        const blocked = await runWithFake(sandbox, db);
        assert.equal(blocked.key, 'containers');
        assert.deepEqual(
          startsOrCreates(callsFrom(before)),
          [],
          'no container starts for the next writer'
        );
        assert.deepEqual(listCopies(sandbox.backupDir), old, 'nothing published or pruned');
        assert.deepEqual(ledgerEntries(), [pending], 'the pending name is still recorded');
        assert.equal(tempLeft().length, 1, 'scratch still kept');

        // The daemon creates the container late. The next writer sees it, removes it, proves it gone,
        // and only then starts its own run.
        writeFileSync(gate, '');
        assert.equal(
          await until(() => containersLeft(sandbox).includes(pending.name), 15_000),
          true,
          'the late create landed'
        );
        const from = readDockerLog(sandbox).length;
        const recovered = await runWithFake(sandbox, db);
        assert.equal(
          recovered.ok,
          true,
          'once the late container is seen and removed, the run completes'
        );
        const later = callsFrom(from);
        const removal = later.findIndex(
          (call) => call.argv[0] === 'rm' && call.argv.includes(pending.name)
        );
        const firstCreate = later.findIndex((call) => call.argv[0] === 'create');
        assert.ok(
          removal >= 0 && removal < firstCreate,
          'the late container is removed before any new create'
        );
        assert.deepEqual(ledgerEntries(), [], 'ledger cleared once the removal was proven');
        assert.deepEqual(containersLeft(sandbox), [], 'no container survives');
        assert.deepEqual(tempLeft(), [], 'scratch of the stopped run removed');
      }
    );
  }
});

describe('docker management calls are bounded, and a hung call is a failure (B2, round 6)', () => {
  const bounded = { BACKUP_DOCKER_TIMEOUT_MS: '1000' };

  it(
    'a version call that never answers ends the run as docker-unavailable: old copies intact, no scratch, no container',
    { timeout: 120_000 },
    async () => {
      const old = seedBackups(sandbox.backupDir, 3);
      const before = old.map((name) => readFileSync(path.join(sandbox.backupDir, name), 'utf8'));
      const started = Date.now();
      const result = await runWithFake(sandbox, db, { ...bounded, FAKE_DOCKER_HANG: 'version' });
      assert.ok(Date.now() - started < 20_000, 'the call was bounded');
      assert.equal(result.ok, false);
      assert.equal(result.key, 'docker');
      assert.equal(result.exit, EXIT.unavailable);
      assert.deepEqual(startsOrCreates(readDockerLog(sandbox)), [], 'no container was sent');
      assert.deepEqual(tempLeft(), [], 'no scratch was created or touched');
      assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
      old.forEach((name, i) =>
        assert.equal(readFileSync(path.join(sandbox.backupDir, name), 'utf8'), before[i])
      );
      assert.match(readStatus(sandbox), new RegExp(`\t${MESSAGES.docker}\n$`));
    }
  );

  it(
    'a ps that never answers after the dump: nothing verified, published or pruned; scratch kept; the next run proves it gone and completes',
    { timeout: 120_000 },
    async () => {
      const old = seedBackups(sandbox.backupDir, 3);
      const before = old.map((name) => readFileSync(path.join(sandbox.backupDir, name), 'utf8'));
      const result = await runWithFake(sandbox, db, { ...bounded, FAKE_DOCKER_HANG: 'ps' });
      assert.equal(result.ok, false);
      assert.equal(result.key, 'containers');
      assert.equal(
        callsFrom(0).some((call) => call.argv.includes('/opt/backup/verify.sh')),
        false,
        'no verification without proof'
      );
      assert.deepEqual(
        listCopies(sandbox.backupDir).sort(),
        [...old].sort(),
        'nothing published or pruned'
      );
      old.forEach((name, i) =>
        assert.equal(readFileSync(path.join(sandbox.backupDir, name), 'utf8'), before[i])
      );
      assert.equal(ledgerEntries().length, 1, 'the dump container stays recorded');
      assert.equal(ledgerEntries()[0].state, 'exists', 'the daemon had created it');
      assert.equal(tempLeft().length, 1, 'scratch kept, not removed under an unproven container');
      assert.equal(
        existsSync(path.join(sandbox.tmp, tempLeft()[0], 'dump.custom')),
        true,
        'the plaintext is still there, untouched'
      );

      const from = readDockerLog(sandbox).length;
      const next = await runWithFake(sandbox, db);
      assert.equal(next.ok, true, 'with ps answering again the next run reconciles and completes');
      assert.ok(
        callsFrom(from).some((call) => call.argv[0] === 'start'),
        'the next run did its own dump'
      );
      assert.deepEqual(ledgerEntries(), []);
      assert.deepEqual(tempLeft(), []);
    }
  );

  it(
    'an rm that never answers while a dump is stopped: the container stays recorded, scratch kept, the next writer waits until removal answers',
    { timeout: 120_000 },
    async () => {
      const old = seedBackups(sandbox.backupDir, 3);
      const before = old.map((name) => readFileSync(path.join(sandbox.backupDir, name), 'utf8'));
      const env = envFor(sandbox, db, {
        FAKE_DOCKER_MODE: 'interrupt',
        ...bounded,
        FAKE_DOCKER_HANG: 'rm',
      });
      const run = startLockedRun({ backupDir: sandbox.backupDir, env, tempRoot: sandbox.tmp });
      assert.equal(
        await until(() => containersLeft(sandbox).length === 1, 15_000),
        true,
        'the dump container is running'
      );
      run.child.kill('SIGTERM');
      const result = await run.done;
      assert.equal(result.ok, false);
      assert.equal(result.key, 'containers');
      assert.equal(containersLeft(sandbox).length, 1, 'the removal never answered');
      const [entry] = ledgerEntries();
      assert.equal(entry.state, 'exists');
      assert.equal(tempLeft().length, 1, 'scratch kept under a container that may still exist');
      assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());

      const from = readDockerLog(sandbox).length;
      const blocked = await runWithFake(sandbox, db, { ...bounded, FAKE_DOCKER_HANG: 'rm' });
      assert.equal(blocked.key, 'containers');
      assert.deepEqual(
        startsOrCreates(callsFrom(from)),
        [],
        'nothing starts while removal is unanswered'
      );
      assert.deepEqual(ledgerEntries(), [entry]);
      old.forEach((name, i) =>
        assert.equal(readFileSync(path.join(sandbox.backupDir, name), 'utf8'), before[i])
      );

      const recovered = await runWithFake(sandbox, db);
      assert.equal(
        recovered.ok,
        true,
        'once removal answers, the stopped container is proven gone'
      );
      assert.deepEqual(containersLeft(sandbox), []);
      const removal = removalEvents(sandbox).find((event) => event.name === entry.name);
      assert.ok(removal && removal.lockHeld === true, 'removed by the writer holding the lock');
      assert.deepEqual(tempLeft(), []);
    }
  );
});
