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
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { cleanupArgs, DockerRunner } from '../docker.mjs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig } from '../config.mjs';
import { confirmationPaths, readConfirmationState, readRecipientPolicy } from '../confirm.mjs';
import {
  CONFIRMED_RECIPIENT_STATE_NAME,
  ENCRYPTED_CONFIRM_STATE_NAME,
  LEDGER_NAME,
  WAITING_CONFIRMATION_NOTE,
  WAITING_FIRST_CONFIRMATION_NOTE,
} from '../constants.mjs';
import { heldLock, launchLocked } from '../lock.mjs';
import { listBackups, runBackup, writePrivateCopy } from '../pipeline.mjs';
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
  makeProjectRepo,
  makeSandbox,
  readDockerLog,
  readStatus,
  runCli,
  runConfirmWithFake,
  runWithFake,
  seedBackups,
  seedConfirmedRecipient,
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
  it('publishes a complete encrypted copy, prunes 10 fixtures to 2 newest and leaves no plaintext', async () => {
    const old = seedBackups(sandbox.backupDir, 10, { recipientFile: sandbox.recipientFile });
    const result = await runWithFake(sandbox, db);

    assert.equal(result.ok, true);
    assert.equal(result.exit, EXIT.ok);
    assert.equal(result.name, NEW_NAME);
    const copies = listCopies(sandbox.backupDir);
    assert.deepEqual(copies, [old[0], NEW_NAME], '2 newest copies remain');
    assert.equal(
      readFileSync(path.join(sandbox.backupDir, NEW_NAME), 'utf8'),
      'age-encryption.org/v1\nFAKE-CIPHERTEXT\n'
    );
    assert.deepEqual(tempLeft(), [], 'plaintext and temporary cluster removed');
  });

  it('respects explicit BACKUP_RETENTION_COUNT', async () => {
    const old = seedBackups(sandbox.backupDir, 10, { recipientFile: sandbox.recipientFile });
    const result = await runWithFake(sandbox, db, { BACKUP_RETENTION_COUNT: '5' });
    assert.equal(result.ok, true);
    const copies = listCopies(sandbox.backupDir);
    assert.equal(copies.length, 5);
    assert.ok(copies.includes(NEW_NAME));
    for (const kept of old.slice(0, 4)) assert.ok(copies.includes(kept));
  });

  it('defaults to unencrypted pg_dump -Fc without age key, skips encrypt container, and shares limit with .age', async () => {
    const existingAge = seedBackups(sandbox.backupDir, 2, { encrypted: true });
    const env = envFor(sandbox, db);
    delete env.BACKUP_ENCRYPT;
    delete env.BACKUP_AGE_RECIPIENT_FILE;
    const result = await startLockedRun({
      backupDir: sandbox.backupDir,
      env,
      tempRoot: sandbox.tmp,
      projectRoot: sandbox.repo,
    }).done;

    assert.equal(result.ok, true);
    assert.equal(result.name, 'clickmoji-20261124T120000Z.dump');
    const copies = listCopies(sandbox.backupDir);
    assert.deepEqual(copies, [existingAge[0], 'clickmoji-20261124T120000Z.dump']);
    assert.equal(
      readFileSync(path.join(sandbox.backupDir, 'clickmoji-20261124T120000Z.dump'), 'utf8'),
      'FAKE-DUMP'
    );
    const created = readDockerLog(sandbox).filter((c) => c.argv[0] === 'create');
    assert.equal(created.length, 2, 'only dump and verify containers ran');
    assert.equal(
      created.some((c) => c.argv.includes('age')),
      false
    );
    assert.deepEqual(tempLeft(), [], 'intermediate dump.custom and temp cluster removed');
  });

  it('writes one status line with date, size and verification, and no secrets', async () => {
    seedBackups(sandbox.backupDir, 3, { recipientFile: sandbox.recipientFile });
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
      const old = seedBackups(sandbox.backupDir, 100, { recipientFile: sandbox.recipientFile });
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

describe('drops against the previous accepted copy of any age', () => {
  it('rejects a table that fell by more than 20%, preserves both old copies, and logs reason', async () => {
    const old = seedBackups(sandbox.backupDir, 2, {
      counts: { a: 100, b: 100 },
      recipientFile: sandbox.recipientFile,
    });
    const result = await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":10,"b":100}' });
    assert.equal(result.ok, false);
    assert.equal(result.exit, EXIT.suspicious);
    assert.equal(result.key, 'drop');
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
    assert.ok(!listCopies(sandbox.backupDir).includes(NEW_NAME));
    assert.match(readStatus(sandbox), /\tfailed\tсбой: число строк упало более чем на 20%\n$/);
  });

  it('compares against an accepted copy older than two days (e.g. 10 days old)', async () => {
    const old = seedBackups(sandbox.backupDir, 2, {
      startDay: 10,
      counts: { a: 100, b: 100 },
      recipientFile: sandbox.recipientFile,
    });
    const result = await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":50,"b":100}' });
    assert.equal(result.ok, false);
    assert.equal(result.exit, EXIT.suspicious);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
  });

  it('single-run confirmation accepts the drop, updates baseline, and subsequent normal run passes', async () => {
    const old = seedBackups(sandbox.backupDir, 2, {
      startDay: 10,
      counts: { a: 100, b: 100 },
      recipientFile: sandbox.recipientFile,
    });
    const confirmed = await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":10,"b":100}' }, NOW, {
      allowRowDrop: true,
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.exit, EXIT.ok);
    assert.equal(confirmed.verify, 'ok');
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [old[0], NEW_NAME].sort());
    const meta = JSON.parse(
      readFileSync(path.join(sandbox.backupDir, 'meta', `${NEW_NAME}.json`), 'utf8')
    );
    assert.equal(meta.verify, 'ok');
    assert.deepEqual(meta.counts, { a: 10, b: 100 });

    // Next normal run without confirmation uses updated baseline (a: 10) and succeeds.
    const nextNow = new Date(NOW.getTime() + 86_400_000);
    const next = await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":9,"b":100}' }, nextNow);
    assert.equal(next.ok, true);
    assert.equal(next.exit, EXIT.ok);
  });

  it('does not flag a fall of exactly 20%', async () => {
    seedBackups(sandbox.backupDir, 1, {
      counts: { a: 100 },
      recipientFile: sandbox.recipientFile,
    });
    const result = await runWithFake(sandbox, db, {
      FAKE_COUNTS: '{"a":80}',
      FAKE_IDENTITIES: 'a\tid int4 NO',
    });
    assert.equal(result.ok, true);
    assert.equal(result.verify, 'ok');
  });
});

describe('encryption transition and atomic temp publish', () => {
  it('B2: enabling encryption keeps full set of N unencrypted copies + 1 encrypted copy until confirmed and next run publishes', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const result = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' });
    assert.equal(result.ok, true);
    assert.equal(result.waitingForConfirmation, true);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain, NEW_NAME].sort());
    for (const old of oldPlain) {
      assert.equal(existsSync(path.join(sandbox.backupDir, old)), true);
      assert.equal(existsSync(path.join(sandbox.backupDir, 'meta', `${old}.json`)), true);
    }
    assert.match(readStatus(sandbox), new RegExp(`${WAITING_CONFIRMATION_NOTE}`));
    const meta = JSON.parse(
      readFileSync(path.join(sandbox.backupDir, 'meta', `${NEW_NAME}.json`), 'utf8')
    );
    assert.equal(meta.verifyScope, 'plaintext');
  });

  it('enabling encryption preserves unencrypted copies when dump/verify/encrypt fails or row drop rejects', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      encrypted: false,
      counts: { a: 100, b: 100 },
    });
    const failed = await runWithFake(sandbox, db, {
      BACKUP_ENCRYPT: '1',
      FAKE_DOCKER_MODE: 'encrypt-fail',
    });
    assert.equal(failed.ok, false);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain].sort());

    const rejected = await runWithFake(sandbox, db, {
      BACKUP_ENCRYPT: '1',
      FAKE_COUNTS: '{"a":10,"b":100}',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.exit, EXIT.suspicious);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain].sort());
  });

  it('interrupted publish write leaves no partial or final copy, keeps old copies, and excludes partial names from retention', async () => {
    const old = seedBackups(sandbox.backupDir, 2, { recipientFile: sandbox.recipientFile });
    // Plant leftover partial files as if an earlier run crashed during write.
    writeFileSync(
      path.join(sandbox.backupDir, '.partial-clickmoji-20261125T000000Z.dump.age'),
      'half'
    );
    writeFileSync(path.join(sandbox.backupDir, '.partial-clickmoji-20261125T000000Z.dump'), 'half');
    assert.deepEqual(
      listBackups(sandbox.backupDir)
        .map((e) => e.name)
        .sort(),
      [...old].sort(),
      'partial names excluded'
    );

    const env = envFor(sandbox, db);
    const gate = path.join(sandbox.root, 'lock-ready');
    const config = loadConfig(env);
    // Run publishCopy failure directly under a real lock.
    const holder = launchLocked(
      sandbox.backupDir,
      [
        process.execPath,
        '-e',
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(gate)}, ''); setInterval(()=>{}, 1000);`,
      ],
      { stdio: 'ignore' }
    );
    await until(() => existsSync(gate), 5000);
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('close', resolve));

    const writer = launchLocked(
      sandbox.backupDir,
      [
        process.execPath,
        '--input-type=module',
        '-e',
        `
        import { writeFileSync } from 'node:fs';
        import { loadConfig } from ${JSON.stringify(path.resolve('scripts/backup/config.mjs'))};
        import { DockerRunner } from ${JSON.stringify(path.resolve('scripts/backup/docker.mjs'))};
        import { heldLock } from ${JSON.stringify(path.resolve('scripts/backup/lock.mjs'))};
        import { runBackup } from ${JSON.stringify(path.resolve('scripts/backup/pipeline.mjs'))};
        const env = ${JSON.stringify(env)};
        const config = loadConfig(env);
        const lock = heldLock(config.backupDir, process.env);
        const docker = new DockerRunner({ bin: config.dockerBin, containerEnv: config.containerEnv, timeoutMs: config.dockerTimeoutMs, env });
        const res = await runBackup({
          config, docker, lock, now: () => new Date(${JSON.stringify(NOW.toISOString())}),
          tempRoot: ${JSON.stringify(sandbox.tmp)},
          projectRoot: ${JSON.stringify(sandbox.repo)},
          publishCopy: (_src, dest) => { writeFileSync(dest, 'partial'); throw new Error('disk full'); },
        });
        console.log(JSON.stringify(res));
        `,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    writer.stdout.on('data', (c) => {
      out += c;
    });
    await new Promise((resolve) => writer.on('close', resolve));
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.key, 'publish');
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
    assert.equal(existsSync(path.join(sandbox.backupDir, `.partial-${NEW_NAME}`)), false);
    assert.equal(existsSync(path.join(sandbox.backupDir, NEW_NAME)), false);
  });

  it('partial file and directory permissions stay 0600/0700 even under permissive umask 0000', async () => {
    mkdirSync(sandbox.backupDir, { recursive: true, mode: 0o755 });
    chmodSync(sandbox.backupDir, 0o755);
    const env = envFor(sandbox, db);
    const writer = launchLocked(
      sandbox.backupDir,
      [
        process.execPath,
        '--input-type=module',
        '-e',
        `
        import { statSync } from 'node:fs';
        import { loadConfig } from ${JSON.stringify(path.resolve('scripts/backup/config.mjs'))};
        import { DockerRunner } from ${JSON.stringify(path.resolve('scripts/backup/docker.mjs'))};
        import { heldLock } from ${JSON.stringify(path.resolve('scripts/backup/lock.mjs'))};
        import { runBackup, writePrivateCopy } from ${JSON.stringify(path.resolve('scripts/backup/pipeline.mjs'))};
        process.umask(0o000);
        const env = ${JSON.stringify(env)};
        const config = loadConfig(env);
        const lock = heldLock(config.backupDir, process.env);
        const docker = new DockerRunner({ bin: config.dockerBin, containerEnv: config.containerEnv, timeoutMs: config.dockerTimeoutMs, env });
        let partialMode = null;
        const res = await runBackup({
          config, docker, lock, now: () => new Date(${JSON.stringify(NOW.toISOString())}),
          tempRoot: ${JSON.stringify(sandbox.tmp)},
          projectRoot: ${JSON.stringify(sandbox.repo)},
          publishCopy: (src, dest) => { writePrivateCopy(src, dest); partialMode = statSync(dest).mode & 0o777; },
        });
        console.log(JSON.stringify({ res, partialMode }));
        `,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    writer.stdout.on('data', (c) => {
      out += c;
    });
    await new Promise((resolve) => writer.on('close', resolve));
    const { res, partialMode } = JSON.parse(out.trim().split('\n').pop());
    assert.equal(res.ok, true);
    assert.equal(partialMode, 0o600, 'partial file created with 0600 under umask 0000');
    assert.equal(
      statSync(sandbox.backupDir).mode & 0o777,
      0o700,
      'existing backupDir tightened to 0700'
    );
    assert.equal(
      statSync(path.join(sandbox.backupDir, NEW_NAME)).mode & 0o777,
      0o600,
      'final file is 0600'
    );
    assert.equal(
      statSync(path.join(sandbox.backupDir, 'meta', `${NEW_NAME}.json`)).mode & 0o777,
      0o600,
      'meta file is 0600'
    );
  });

  it('re-checks git check-ignore right before publish and aborts if .gitignore drops backups mid-run', async () => {
    const { repo, backupDir: targetBackups } = makeProjectRepo(
      path.join(sandbox.root, 'midrun-repo'),
      { copyScripts: false }
    );
    // Flip .gitignore during the encrypt step (right before pre-publish git check-ignore).
    const gitWrapper = path.join(sandbox.root, 'git-flip.mjs');
    const flipState = path.join(sandbox.root, 'flipped');
    writeFileSync(
      gitWrapper,
      `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const tmpRoot = ${JSON.stringify(sandbox.tmp)};
const repo = ${JSON.stringify(repo)};
const flipState = ${JSON.stringify(flipState)};
if (!existsSync(flipState)) {
  const dirs = readdirSync(tmpRoot).filter((d) => d.startsWith('clickmoji-backup-'));
  for (const d of dirs) {
    if (existsSync(path.join(tmpRoot, d, 'dump.age'))) {
      writeFileSync(path.join(repo, '.gitignore'), '');
      writeFileSync(flipState, '1');
      break;
    }
  }
}
const r = spawnSync('git', process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'] });
process.exit(r.status ?? 1);
`,
      { mode: 0o755 }
    );
    chmodSync(gitWrapper, 0o755);

    const result = await runWithFake(
      sandbox,
      db,
      {
        BACKUP_DIR: targetBackups,
        BACKUP_GIT_BIN: gitWrapper,
      },
      NOW,
      { projectRoot: repo }
    );
    assert.equal(result.ok, false);
    assert.equal(result.key, 'notIgnored');
    assert.equal(result.exit, EXIT.failed);
    assert.deepEqual(listCopies(targetBackups), [], 'nothing published after mid-run unignore');
    assert.match(
      readStatus(sandbox),
      /\tfailed\tсбой: каталог резервных копий не игнорируется git\n$/
    );
  });

  it('SIGKILL between the two renames leaves orphaned C that does not count for baseline or displace A/B; next run D keeps D and B (B1)', async () => {
    const old = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      counts: { a: 100, b: 100 },
      recipientFile: sandbox.recipientFile,
    });
    const [bName, aName] = old; // old[0] is day-2 (B, newer), old[1] is day-3 (A, older)
    const crashTime = new Date(NOW.getTime() - 86_400_000); // day-1 (C)
    const crashName = 'clickmoji-20261123T120000Z.dump.age';
    const env = envFor(sandbox, db, { FAKE_COUNTS: '{"a":100,"b":100}' });

    const writer = launchLocked(
      sandbox.backupDir,
      [
        process.execPath,
        '--input-type=module',
        '-e',
        `
        import { loadConfig } from ${JSON.stringify(path.resolve('scripts/backup/config.mjs'))};
        import { DockerRunner } from ${JSON.stringify(path.resolve('scripts/backup/docker.mjs'))};
        import { heldLock } from ${JSON.stringify(path.resolve('scripts/backup/lock.mjs'))};
        import { runBackup } from ${JSON.stringify(path.resolve('scripts/backup/pipeline.mjs'))};
        const env = ${JSON.stringify(env)};
        const config = loadConfig(env);
        const lock = heldLock(config.backupDir, process.env);
        const docker = new DockerRunner({ bin: config.dockerBin, containerEnv: config.containerEnv, timeoutMs: config.dockerTimeoutMs, env });
        await runBackup({
          config, docker, lock,
          now: () => new Date(${JSON.stringify(crashTime.toISOString())}),
          tempRoot: ${JSON.stringify(sandbox.tmp)},
          projectRoot: ${JSON.stringify(sandbox.repo)},
          onBeforeMetaRename: () => process.kill(process.pid, 'SIGKILL'),
        });
        `,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const signal = await new Promise((resolve) => writer.on('close', (_code, sig) => resolve(sig)));
    assert.equal(signal, 'SIGKILL', 'crashed hard between the two renames');
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'lock released on SIGKILL');

    // Verify exact crash-between-renames state: C dump exists, partial meta exists, final meta does NOT exist.
    assert.equal(existsSync(path.join(sandbox.backupDir, crashName)), true);
    assert.equal(
      existsSync(path.join(sandbox.backupDir, 'meta', `.partial-${crashName}.json`)),
      true
    );
    assert.equal(existsSync(path.join(sandbox.backupDir, 'meta', `${crashName}.json`)), false);
    assert.deepEqual(
      listBackups(sandbox.backupDir)
        .map((e) => e.name)
        .sort(),
      [aName, bName].sort(),
      'orphaned C is not counted as an accepted copy'
    );

    // A row-drop run compares against B (100 rows), not C, and rejects while keeping A and B intact.
    const rejected = await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":10,"b":100}' }, NOW);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.exit, EXIT.suspicious);
    assert.equal(existsSync(path.join(sandbox.backupDir, aName)), true);
    assert.equal(existsSync(path.join(sandbox.backupDir, bName)), true);

    // Next healthy run D succeeds: retention keeps D and B, prunes A, and C does not displace B.
    const next = await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":100,"b":100}' }, NOW);
    assert.equal(next.ok, true);
    assert.equal(next.name, NEW_NAME);
    assert.deepEqual(
      listBackups(sandbox.backupDir)
        .map((e) => e.name)
        .sort(),
      [bName, NEW_NAME].sort()
    );
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [bName, NEW_NAME].sort());
    assert.equal(existsSync(path.join(sandbox.backupDir, aName)), false, 'A pruned');
    assert.equal(existsSync(path.join(sandbox.backupDir, crashName)), false, 'orphaned C cleared');
    assert.equal(
      existsSync(path.join(sandbox.backupDir, 'meta', `.partial-${crashName}.json`)),
      false,
      'leftover partial meta cleared'
    );
  });

  it('keeps compatibility with prior-version accepted metadata (without encrypted field) for baseline, retention, and purge (B1)', async () => {
    const oldLegacy = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      counts: { a: 100, b: 100 },
      encrypted: true,
      legacy: true,
    });
    seedConfirmedRecipient(sandbox.backupDir, sandbox.recipientFile, oldLegacy[0]);
    const [bName, aName] = oldLegacy;

    // Baseline check reads legacy B metadata without `encrypted` field and flags >20% drop.
    const rejected = await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":10,"b":100}' }, NOW);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.exit, EXIT.suspicious);

    // Normal run accepts D and prunes legacy A while keeping legacy B.
    const ok = await runWithFake(sandbox, db, { FAKE_COUNTS: '{"a":100,"b":100}' }, NOW);
    assert.equal(ok.ok, true);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [bName, NEW_NAME].sort());
    assert.equal(existsSync(path.join(sandbox.backupDir, aName)), false);
  });

  it('encryption transition purges orphaned unencrypted dumps immediately while preserving accepted unencrypted copies until confirmed (B1/B2)', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      encrypted: false,
      counts: { a: 100, b: 100 },
    });
    const orphanPlain = 'clickmoji-20261123T120000Z.dump';
    writeFileSync(path.join(sandbox.backupDir, orphanPlain), 'ORPHAN');

    const res = await runWithFake(sandbox, db, {
      BACKUP_ENCRYPT: '1',
      FAKE_COUNTS: '{"a":100,"b":100}',
    });
    assert.equal(res.ok, true);
    assert.equal(res.waitingForConfirmation, true);
    assert.equal(existsSync(path.join(sandbox.backupDir, orphanPlain)), false, 'orphan purged');
    assert.deepEqual(
      listCopies(sandbox.backupDir).sort(),
      [...oldPlain, NEW_NAME].sort(),
      'accepted unencrypted copies kept until operator confirmation'
    );
  });

  it('B3: checks exact physical temporary and final paths (including metadata) against /backups/* with targeted negations', async () => {
    const old = seedBackups(sandbox.backupDir, 2, { encrypted: false });
    const plainName = 'clickmoji-20261124T120000Z.dump';
    const cases = [
      `/backups/*\n!/backups/${plainName}\n`,
      `/backups/*\n!/backups/.partial-${plainName}\n`,
      `/backups/*\n!/backups/meta/\n!/backups/meta/${plainName}.json\n`,
      `/backups/*\n!/backups/meta/\n!/backups/meta/.partial-${plainName}.json\n`,
    ];

    for (const gi of cases) {
      writeFileSync(path.join(sandbox.repo, '.gitignore'), gi);
      const env = envFor(sandbox, db);
      delete env.BACKUP_ENCRYPT;
      delete env.BACKUP_AGE_RECIPIENT_FILE;
      const result = await startLockedRun({
        backupDir: sandbox.backupDir,
        env,
        now: NOW,
        tempRoot: sandbox.tmp,
        projectRoot: sandbox.repo,
      }).done;
      assert.equal(result.ok, false, `must reject rule:\n${gi}`);
      assert.equal(result.key, 'notIgnored');
      assert.equal(result.exit, EXIT.failed);
      assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
      assert.equal(existsSync(path.join(sandbox.backupDir, plainName)), false);
      assert.equal(existsSync(path.join(sandbox.backupDir, `.partial-${plainName}`)), false);
      assert.equal(existsSync(path.join(sandbox.backupDir, 'meta', `${plainName}.json`)), false);
      assert.equal(
        existsSync(path.join(sandbox.backupDir, 'meta', `.partial-${plainName}.json`)),
        false
      );
      assert.match(
        readStatus(sandbox),
        /\tfailed\tсбой: каталог резервных копий не игнорируется git\n$/
      );
      const status = spawnSync(
        'git',
        ['-C', sandbox.repo, 'status', '--porcelain', '--untracked-files=all'],
        { encoding: 'utf8' }
      );
      if (gi.includes('/backups/meta/')) {
        assert.equal(status.stdout.includes(plainName), false, 'new copy/meta never untracked');
      } else {
        assert.equal(
          status.stdout.trim(),
          'M .gitignore',
          'no backup or metadata files leaked to git status'
        );
      }
    }
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
    const old = seedBackups(sandbox.backupDir, 20, { recipientFile: sandbox.recipientFile });
    const env = envFor(sandbox, db, { FAKE_DOCKER_MODE: 'interrupt' });
    const run = startLockedRun({
      backupDir: sandbox.backupDir,
      env,
      tempRoot: sandbox.tmp,
      projectRoot: sandbox.repo,
    });
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
    const run = startLockedRun({
      backupDir: sandbox.backupDir,
      env,
      tempRoot: sandbox.tmp,
      projectRoot: sandbox.repo,
    });
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
      const repoInfo = makeProjectRepo(path.join(sandbox.root, `repo-${label}`), {
        copyScripts: false,
      });
      const statusFile = path.join(sandbox.root, `status-${label}.log`);
      const env = envFor({ ...sandbox, backupDir: repoInfo.backupDir, statusFile }, db);
      return startLockedRun({
        backupDir: repoInfo.backupDir,
        env,
        tempRoot: tmpRoot,
        projectRoot: repoInfo.repo,
      }).done;
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
    const old = seedBackups(sandbox.backupDir, 100, { recipientFile: sandbox.recipientFile });
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
    seedBackups(sandbox.backupDir, 2, { recipientFile: sandbox.recipientFile });
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
        projectRoot: sandbox.repo,
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
        projectRoot: sandbox.repo,
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
    const old = seedBackups(sandbox.backupDir, 3, { recipientFile: sandbox.recipientFile });
    const result = await runWithFake(sandbox, db, { FAKE_SWAP_STATUS: sandbox.statusFile });
    assert.equal(result.ok, true);
    assert.equal(result.saved, true);
    assert.equal(result.statusWritten, false);
    assert.equal(result.exit, EXIT.statusFailed);
    assert.ok(listCopies(sandbox.backupDir).includes(NEW_NAME), 'the copy is there');
    assert.deepEqual(
      listCopies(sandbox.backupDir).sort(),
      [old[0], NEW_NAME].sort(),
      'the copy is saved; retention keeps 2 newest copies'
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
    const result = await runCli(envFor(sandbox, db, { FAKE_SWAP_STATUS: sandbox.statusFile }), [], {
      cli: sandbox.cli,
    });
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
      const old = seedBackups(sandbox.backupDir, 100, { recipientFile: sandbox.recipientFile });
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
      const old = seedBackups(sandbox.backupDir, 100, { recipientFile: sandbox.recipientFile });
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
        seedBackups(sandbox.backupDir, 2, { recipientFile: sandbox.recipientFile });
        const old = listCopies(sandbox.backupDir);
        const gate = path.join(sandbox.root, 'daemon-create.gate');
        const env = envFor(sandbox, db, {
          FAKE_DOCKER_LATE_CREATE: gate,
          FAKE_DOCKER_CREATE: failure,
        });

        // The create client is sent and never answers. The run is stopped while the create is in flight.
        const run = startLockedRun({
          backupDir: sandbox.backupDir,
          env,
          tempRoot: sandbox.tmp,
          projectRoot: sandbox.repo,
        });
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
      const old = seedBackups(sandbox.backupDir, 3, { recipientFile: sandbox.recipientFile });
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
      const old = seedBackups(sandbox.backupDir, 3, { recipientFile: sandbox.recipientFile });
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
      const old = seedBackups(sandbox.backupDir, 3, { recipientFile: sandbox.recipientFile });
      const before = old.map((name) => readFileSync(path.join(sandbox.backupDir, name), 'utf8'));
      const env = envFor(sandbox, db, {
        FAKE_DOCKER_MODE: 'interrupt',
        ...bounded,
        FAKE_DOCKER_HANG: 'rm',
      });
      const run = startLockedRun({
        backupDir: sandbox.backupDir,
        env,
        tempRoot: sandbox.tmp,
        projectRoot: sandbox.repo,
      });
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

describe('B2: operator confirmation gate before purging unencrypted dumps', () => {
  const dayPlus = (hours) => new Date(NOW.getTime() + hours * 3_600_000);

  it('caps unconfirmed retention at max(N, plainKept + 1), fills only free slots with other .age, and keeps baseline, status, and files consistent', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      encrypted: false,
      counts: { a: 100, b: 20 },
    });

    const r1 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', FAKE_COUNTS: '{"a":100,"b":20}' },
      NOW
    );
    assert.equal(r1.ok, true);
    assert.equal(r1.retained, true);
    assert.equal(r1.saved, true);
    assert.equal(r1.waitingForConfirmation, true);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain, r1.name].sort());

    // Repeated unconfirmed run when plainKept === N (N=2): r2 is pruned so total stays N+1=3 (never N+2)
    // and status/baseline remain consistent with the surviving r1 (never claiming r2 was saved).
    const r2Time = dayPlus(24);
    const r2Name = 'clickmoji-20261125T120000Z.dump.age';
    const r2 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', FAKE_COUNTS: '{"a":200,"b":20}' },
      r2Time
    );
    assert.equal(r2.ok, true);
    assert.equal(r2.retained, false);
    assert.equal(r2.saved, false);
    assert.equal(r2.name, null);
    assert.equal(r2.keptFile, r1.name);
    assert.equal(r2.waitingForConfirmation, true);
    assert.deepEqual(
      listCopies(sandbox.backupDir).sort(),
      [...oldPlain, r1.name].sort(),
      'first .age (r1) preserved, N plain intact, total capped at N+1'
    );
    assert.equal(existsSync(path.join(sandbox.backupDir, r2Name)), false);
    assert.equal(existsSync(path.join(sandbox.backupDir, 'meta', `${r2Name}.json`)), false);
    const r2StatusLine = readStatus(sandbox).trim().split('\n').pop();
    assert.equal(r2StatusLine.includes(r2Name), false, 'status never names deleted copy');
    assert.match(
      r2StatusLine,
      new RegExp(`verify=ok decrypt=unconfirmed kept=${r1.name} new=pruned prune=ok`)
    );

    // Baseline remained r1 (a=100), NOT deleted r2 (a=200): a=90 on r3 passes without drop!
    const r3Name = 'clickmoji-20261126T120000Z.dump.age';
    const r3 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', FAKE_COUNTS: '{"a":90,"b":20}' },
      dayPlus(48)
    );
    assert.equal(r3.ok, true);
    assert.equal(r3.retained, false);
    assert.equal(r3.saved, false);
    assert.equal(r3.keptFile, r1.name);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain, r1.name].sort());
    assert.equal(existsSync(path.join(sandbox.backupDir, r3Name)), false);
    assert.equal(existsSync(path.join(sandbox.backupDir, 'meta', `${r3Name}.json`)), false);

    // Even with --allow-row-drop when fresh copy is pruned, baseline stays r1 (a=100), so subsequent a=10 still rejects.
    const r4DropAllowed = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', FAKE_COUNTS: '{"a":10,"b":20}' },
      dayPlus(72),
      { allowRowDrop: true }
    );
    assert.equal(r4DropAllowed.ok, true);
    assert.equal(r4DropAllowed.retained, false);
    const r5Rejected = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', FAKE_COUNTS: '{"a":10,"b":20}' },
      dayPlus(96)
    );
    assert.equal(r5Rejected.ok, false);
    assert.equal(r5Rejected.exit, EXIT.suspicious);

    // If status write fails when fresh copy is pruned (saved === false), report does NOT return statusSaved (5).
    const statusFailPruned = await runWithFake(
      sandbox,
      db,
      {
        BACKUP_ENCRYPT: '1',
        FAKE_COUNTS: '{"a":100,"b":20}',
        FAKE_SWAP_STATUS: sandbox.statusFile,
      },
      dayPlus(120)
    );
    assert.equal(statusFailPruned.ok, true);
    assert.equal(statusFailPruned.retained, false);
    assert.equal(statusFailPruned.saved, false);
    assert.equal(statusFailPruned.statusWritten, false);
    assert.equal(statusFailPruned.exit, EXIT.failed);
  });

  it('fills only free slots in normal limit N when plainKept < N before confirmation', async () => {
    const [p1] = seedBackups(sandbox.backupDir, 1, {
      startDay: 2,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });

    // N=3, plainKept=1 -> r1 (2 <= 3), then r2 fills the 1 free slot (3 = N), then r3 replaces r2 while keeping p1 + r1.
    const r1 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '3' },
      NOW
    );
    assert.equal(r1.ok, true);
    assert.equal(r1.retained, true);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [p1, r1.name].sort());

    const r2 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '3' },
      dayPlus(24)
    );
    assert.equal(r2.retained, true);
    assert.equal(r2.saved, true);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [p1, r1.name, r2.name].sort());

    const r3 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '3' },
      dayPlus(48)
    );
    assert.equal(r3.retained, true);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [p1, r1.name, r3.name].sort());
    assert.equal(existsSync(path.join(sandbox.backupDir, r2.name)), false);
  });

  it('confirmation records date, filename, and ciphertext hash under lock without touching DB/docker or deleting copies, and next encrypted publish cleans up to N', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });

    const r1 = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, NOW);
    assert.equal(r1.ok, true);
    const dockerCallsBeforeConfirm = readDockerLog(sandbox).length;

    const confirm = await runConfirmWithFake(sandbox, r1.name, {}, dayPlus(1));
    assert.equal(confirm.ok, true);
    assert.equal(confirm.file, r1.name);
    assert.equal(confirm.confirmedAt, dayPlus(1).toISOString());
    assert.equal(readDockerLog(sandbox).length, dockerCallsBeforeConfirm, 'no docker called');
    assert.deepEqual(
      listCopies(sandbox.backupDir).sort(),
      [...oldPlain, r1.name].sort(),
      'confirmation deletes nothing'
    );

    const state = readConfirmationState(sandbox.backupDir);
    assert.equal(state.file, r1.name);
    assert.equal(state.confirmedAt, dayPlus(1).toISOString());
    assert.match(state.sha256, /^[0-9a-f]{64}$/);
    const stateFile = confirmationPaths(sandbox.backupDir).stateFile;
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);

    // Repeat confirmation is idempotent and deletes nothing
    const repeatConfirm = await runConfirmWithFake(sandbox, r1.name, {}, dayPlus(2));
    assert.equal(repeatConfirm.ok, true);
    assert.equal(readConfirmationState(sandbox.backupDir).confirmedAt, dayPlus(2).toISOString());

    // Next successful encrypted backup publishes r2 and then removes all plain copies and returns to N=2
    const r2 = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, dayPlus(24));
    assert.equal(r2.ok, true);
    assert.equal(r2.waitingForConfirmation, false);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [r1.name, r2.name].sort());
    for (const p of oldPlain) {
      assert.equal(existsSync(path.join(sandbox.backupDir, p)), false);
      assert.equal(existsSync(path.join(sandbox.backupDir, 'meta', `${p}.json`)), false);
    }
    assert.equal(existsSync(stateFile), false, 'confirmation state consumed and cleared');
    assert.doesNotMatch(readStatus(sandbox).trim().split('\n').pop(), /decrypt=unconfirmed/);
  });

  it('failure or crash after confirmation and before full publication preserves old plain copies and confirmation state', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      encrypted: false,
      counts: { a: 100, b: 100 },
    });
    const r1 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', FAKE_COUNTS: '{"a":100,"b":100}' },
      NOW
    );
    assert.equal(r1.ok, true);
    assert.equal((await runConfirmWithFake(sandbox, r1.name, {}, dayPlus(1))).ok, true);

    // 1. Encryption failure preserves plain + confirmation
    const encFail = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', FAKE_DOCKER_MODE: 'encrypt-fail' },
      dayPlus(12)
    );
    assert.equal(encFail.ok, false);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain, r1.name].sort());
    assert.ok(readConfirmationState(sandbox.backupDir));

    // 2. Row-drop guard rejection preserves plain + confirmation
    const dropFail = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', FAKE_COUNTS: '{"a":10,"b":100}' },
      dayPlus(13)
    );
    assert.equal(dropFail.exit, EXIT.suspicious);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain, r1.name].sort());
    assert.ok(readConfirmationState(sandbox.backupDir));

    // 3. SIGKILL between the two renames preserves plain + confirmation, and next healthy run cleans up
    const env = envFor(sandbox, db, { BACKUP_ENCRYPT: '1', FAKE_COUNTS: '{"a":100,"b":100}' });
    const writer = launchLocked(
      sandbox.backupDir,
      [
        process.execPath,
        '--input-type=module',
        '-e',
        `
        import { loadConfig } from ${JSON.stringify(path.resolve('scripts/backup/config.mjs'))};
        import { DockerRunner } from ${JSON.stringify(path.resolve('scripts/backup/docker.mjs'))};
        import { heldLock } from ${JSON.stringify(path.resolve('scripts/backup/lock.mjs'))};
        import { runBackup } from ${JSON.stringify(path.resolve('scripts/backup/pipeline.mjs'))};
        const env = ${JSON.stringify(env)};
        const config = loadConfig(env);
        const lock = heldLock(config.backupDir, process.env);
        const docker = new DockerRunner({ bin: config.dockerBin, containerEnv: config.containerEnv, timeoutMs: config.dockerTimeoutMs, env });
        await runBackup({
          config, docker, lock,
          now: () => new Date(${JSON.stringify(dayPlus(14).toISOString())}),
          tempRoot: ${JSON.stringify(sandbox.tmp)},
          projectRoot: ${JSON.stringify(sandbox.repo)},
          onBeforeMetaRename: () => process.kill(process.pid, 'SIGKILL'),
        });
        `,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    await new Promise((resolve) => writer.on('close', resolve));
    assert.deepEqual(
      listBackups(sandbox.backupDir)
        .map((e) => e.name)
        .sort(),
      [...oldPlain, r1.name].sort()
    );
    assert.ok(readConfirmationState(sandbox.backupDir));

    // Recovery run succeeds, publishes r2, and purges oldPlain
    const r2 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', FAKE_COUNTS: '{"a":100,"b":100}' },
      dayPlus(24)
    );
    assert.equal(r2.ok, true);
    assert.equal(r2.waitingForConfirmation, false);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [r1.name, r2.name].sort());
    assert.equal(readConfirmationState(sandbox.backupDir), null);
  });

  it('tampered/substituted encrypted file or changed recipient after confirmation does NOT authorize cleanup', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const r1 = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, NOW);
    assert.equal(r1.ok, true);
    assert.equal((await runConfirmWithFake(sandbox, r1.name, {}, dayPlus(1))).ok, true);

    // Tamper with ciphertext bytes of r1 (and even rewrite its meta sha256 to simulate substitution)
    const r1Path = path.join(sandbox.backupDir, r1.name);
    const r1MetaPath = path.join(sandbox.backupDir, 'meta', `${r1.name}.json`);
    const fakePayload = 'age-encryption.org/v1\nSUBSTITUTED\n';
    writeFileSync(r1Path, fakePayload);
    const metaObj = JSON.parse(readFileSync(r1MetaPath, 'utf8'));
    metaObj.sizeBytes = Buffer.byteLength(fakePayload);
    metaObj.sha256 = crypto.createHash('sha256').update(fakePayload).digest('hex');
    writeFileSync(r1MetaPath, JSON.stringify(metaObj));

    const r2 = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, dayPlus(24));
    assert.equal(r2.ok, true);
    assert.equal(r2.waitingForConfirmation, true, 'substituted file did not authorize cleanup');
    for (const p of oldPlain) {
      assert.equal(existsSync(path.join(sandbox.backupDir, p)), true, `${p} preserved`);
    }

    // Also verify recipient mismatch after valid confirmation refuses cleanup
    const mismatchSandbox = makeSandbox();
    try {
      const mPlain = seedBackups(mismatchSandbox.backupDir, 2, {
        startDay: 2,
        encrypted: false,
        counts: { a: 10, b: 20 },
      });
      const m1 = await runWithFake(mismatchSandbox, db, { BACKUP_ENCRYPT: '1' }, NOW);
      assert.equal(m1.ok, true);
      assert.equal((await runConfirmWithFake(mismatchSandbox, m1.name, {}, dayPlus(1))).ok, true);
      const otherRecipientFile = path.join(mismatchSandbox.root, 'other-recipient.txt');
      writeFileSync(otherRecipientFile, `age1${'p'.repeat(58)}\n`);
      const m2 = await runWithFake(
        mismatchSandbox,
        db,
        { BACKUP_ENCRYPT: '1', BACKUP_AGE_RECIPIENT_FILE: otherRecipientFile },
        dayPlus(24)
      );
      assert.equal(m2.ok, false);
      assert.equal(m2.key, 'recipientMismatch');
      assert.equal(m2.exit, EXIT.failed);
      for (const p of mPlain) {
        assert.equal(existsSync(path.join(mismatchSandbox.backupDir, p)), true, `${p} preserved`);
      }
    } finally {
      mismatchSandbox.cleanup();
    }
  });

  it('stale confirmation cannot authorize a new transition after switching back to unencrypted and returning to encryption', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 4,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const e1 = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, NOW);
    assert.equal((await runConfirmWithFake(sandbox, e1.name, {}, dayPlus(1))).ok, true);

    // Switch back to unencrypted before next encrypted run: publishes pNew and invalidates prior confirmation
    const envPlain = envFor(sandbox, db);
    delete envPlain.BACKUP_ENCRYPT;
    delete envPlain.BACKUP_AGE_RECIPIENT_FILE;
    const pNew = await startLockedRun({
      backupDir: sandbox.backupDir,
      env: envPlain,
      now: dayPlus(24),
      tempRoot: sandbox.tmp,
      projectRoot: sandbox.repo,
    }).done;
    assert.equal(pNew.ok, true);
    assert.equal(
      readConfirmationState(sandbox.backupDir),
      null,
      'unencrypted run cleared stale confirmation'
    );

    // Old e1 cannot be re-confirmed for the new transition either because pNew is newer than e1
    const staleConfirm = await runConfirmWithFake(sandbox, e1.name, {}, dayPlus(25));
    assert.equal(staleConfirm.ok, false);
    assert.equal(staleConfirm.key, 'confirmStale');

    // Switching back to encryption (new transition) does NOT purge pNew without confirming new e2
    const e2 = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, dayPlus(48));
    assert.equal(e2.ok, true);
    assert.equal(e2.waitingForConfirmation, true);
    assert.equal(existsSync(path.join(sandbox.backupDir, pNew.name)), true, 'pNew kept safe');

    // Confirming e2 and running e3 completes the new transition
    assert.equal((await runConfirmWithFake(sandbox, e2.name, {}, dayPlus(49))).ok, true);
    const e3 = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, dayPlus(72));
    assert.equal(e3.ok, true);
    assert.equal(e3.waitingForConfirmation, false);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [e2.name, e3.name].sort());
    assert.equal(existsSync(path.join(sandbox.backupDir, pNew.name)), false);
    for (const p of oldPlain) assert.equal(existsSync(path.join(sandbox.backupDir, p)), false);
  });

  it('corrupted confirmation state file fails closed without publishing or deleting anything', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const metaDir = path.join(sandbox.backupDir, 'meta');
    mkdirSync(metaDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(metaDir, ENCRYPTED_CONFIRM_STATE_NAME), '{not-valid-json');

    const res = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, NOW);
    assert.equal(res.ok, false);
    assert.equal(res.key, 'confirmState');
    assert.equal(res.exit, EXIT.failed);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain].sort());
  });

  it('N=1 confirmed cutover prioritizes confirmed ciphertext over newly published unconfirmed ciphertext and keeps baseline/status consistent', async () => {
    const [p1] = seedBackups(sandbox.backupDir, 1, {
      startDay: 2,
      encrypted: false,
      counts: { a: 100, b: 20 },
    });
    const r1 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '1', FAKE_COUNTS: '{"a":100,"b":20}' },
      NOW
    );
    assert.equal(r1.ok, true);
    assert.equal(r1.retained, true);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [p1, r1.name].sort());
    assert.equal((await runConfirmWithFake(sandbox, r1.name, {}, dayPlus(1))).ok, true);

    const r2Time = dayPlus(24);
    const r2Name = 'clickmoji-20261125T120000Z.dump.age';
    const r2 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '1', FAKE_COUNTS: '{"a":200,"b":20}' },
      r2Time
    );
    assert.equal(r2.ok, true);
    assert.equal(r2.waitingForConfirmation, false);
    assert.equal(r2.retained, false);
    assert.equal(r2.saved, false);
    assert.equal(r2.name, null);
    assert.equal(r2.keptFile, r1.name);
    assert.deepEqual(listCopies(sandbox.backupDir), [r1.name], 'confirmed r1 kept at N=1');
    assert.equal(existsSync(path.join(sandbox.backupDir, p1)), false);
    assert.equal(existsSync(path.join(sandbox.backupDir, r2Name)), false);
    assert.equal(existsSync(path.join(sandbox.backupDir, 'meta', `${r2Name}.json`)), false);
    assert.equal(readConfirmationState(sandbox.backupDir), null);
    const statusLine = readStatus(sandbox).trim().split('\n').pop();
    assert.equal(statusLine.includes(r2Name), false, 'status never claims pruned r2 was saved');
    assert.match(statusLine, new RegExp(`verify=ok kept=${r1.name} new=pruned prune=ok$`));

    // Next run after cutover uses surviving r1 (a=100) as baseline, not pruned r2 (a=200),
    // and now rotates normally under N=1.
    const r3 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '1', FAKE_COUNTS: '{"a":90,"b":20}' },
      dayPlus(48)
    );
    assert.equal(r3.ok, true);
    assert.equal(r3.retained, true);
    assert.equal(r3.saved, true);
    assert.deepEqual(listCopies(sandbox.backupDir), [r3.name]);
  });

  it('cutover run with intermediate .age copies retains operator-confirmed ciphertext under limit N', async () => {
    const [p1] = seedBackups(sandbox.backupDir, 1, {
      startDay: 3,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const r1 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '3' },
      NOW
    );
    assert.equal(r1.ok, true);
    const r2 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '3' },
      dayPlus(24)
    );
    assert.equal(r2.ok, true);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [p1, r1.name, r2.name].sort());
    assert.equal((await runConfirmWithFake(sandbox, r1.name, {}, dayPlus(25))).ok, true);

    // Lower to N=2 at cutover: confirmed r1 MUST remain alongside newest r3 (intermediate r2 and p1 removed).
    const r3 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '2' },
      dayPlus(48)
    );
    assert.equal(r3.ok, true);
    assert.equal(r3.retained, true);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [r1.name, r3.name].sort());
    assert.equal(existsSync(path.join(sandbox.backupDir, r2.name)), false);
    assert.equal(existsSync(path.join(sandbox.backupDir, p1)), false);
  });

  it('cutover requires full publication before cleanup and preserves an available verified copy across every cleanup interruption point', async () => {
    const runInjected = (env, atIso, hookBody) => {
      const child = launchLocked(
        sandbox.backupDir,
        [
          process.execPath,
          '--input-type=module',
          '-e',
          `
          import { loadConfig } from ${JSON.stringify(path.resolve('scripts/backup/config.mjs'))};
          import { DockerRunner } from ${JSON.stringify(path.resolve('scripts/backup/docker.mjs'))};
          import { heldLock } from ${JSON.stringify(path.resolve('scripts/backup/lock.mjs'))};
          import { runBackup } from ${JSON.stringify(path.resolve('scripts/backup/pipeline.mjs'))};
          const env = ${JSON.stringify(env)};
          const config = loadConfig(env);
          const lock = heldLock(config.backupDir, process.env);
          const docker = new DockerRunner({ bin: config.dockerBin, containerEnv: config.containerEnv, timeoutMs: config.dockerTimeoutMs, env });
          await runBackup({
            config, docker, lock,
            now: () => new Date(${JSON.stringify(atIso)}),
            tempRoot: ${JSON.stringify(sandbox.tmp)},
            projectRoot: ${JSON.stringify(sandbox.repo)},
            ${hookBody}
          });
          `,
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return new Promise((resolve) => child.on('close', (_code, sig) => resolve(sig)));
    };

    // 1. N=1: incomplete publication (SIGKILL before meta rename) never runs cleanup.
    const [p1] = seedBackups(sandbox.backupDir, 1, {
      startDay: 2,
      encrypted: false,
      counts: { a: 100, b: 20 },
    });
    const r1 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '1', FAKE_COUNTS: '{"a":100,"b":20}' },
      NOW
    );
    assert.equal((await runConfirmWithFake(sandbox, r1.name, {}, dayPlus(1))).ok, true);
    const n1Env = envFor(sandbox, db, {
      BACKUP_ENCRYPT: '1',
      BACKUP_RETENTION_COUNT: '1',
      FAKE_COUNTS: '{"a":100,"b":20}',
    });
    const r2Name = 'clickmoji-20261125T120000Z.dump.age';
    const sigPub = await runInjected(
      n1Env,
      dayPlus(24).toISOString(),
      `onBeforeMetaRename: () => process.kill(process.pid, 'SIGKILL')`
    );
    assert.equal(sigPub, 'SIGKILL');
    assert.deepEqual(
      listBackups(sandbox.backupDir)
        .map((e) => e.name)
        .sort(),
      [p1, r1.name].sort(),
      'incomplete publication keeps p1 and confirmed r1 intact'
    );
    assert.ok(readConfirmationState(sandbox.backupDir));

    // 2. N=1: interrupt AFTER r2 is removed and BEFORE p1 is removed; both p1 and confirmed r1 survive.
    const r3Time = dayPlus(48);
    const r3Name = 'clickmoji-20261126T120000Z.dump.age';
    const sigMidPrune = await runInjected(
      n1Env,
      r3Time.toISOString(),
      `onBeforePruneRemove: (old, plan) => {
        if (JSON.stringify(plan.remove) !== JSON.stringify([${JSON.stringify(r3Name)}, ${JSON.stringify(p1)}])) {
          throw new Error('unexpected remove order: ' + JSON.stringify(plan.remove));
        }
        if (old === ${JSON.stringify(p1)}) process.kill(process.pid, 'SIGKILL');
      }`
    );
    assert.equal(sigMidPrune, 'SIGKILL');
    assert.equal(existsSync(path.join(sandbox.backupDir, r3Name)), false, 'r3 pruned first');
    assert.deepEqual(
      listBackups(sandbox.backupDir)
        .map((e) => e.name)
        .sort(),
      [p1, r1.name].sort(),
      'interrupt before p1 removal keeps both p1 and confirmed r1'
    );
    assert.ok(readConfirmationState(sandbox.backupDir));

    // Next N=1 run recovers and completes cutover keeping confirmed r1.
    const recoveredN1 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '1', FAKE_COUNTS: '{"a":100,"b":20}' },
      dayPlus(72)
    );
    assert.equal(recoveredN1.ok, true);
    assert.equal(recoveredN1.keptFile, r1.name);
    assert.deepEqual(listCopies(sandbox.backupDir), [r1.name]);
    assert.equal(readConfirmationState(sandbox.backupDir), null);

    // 3. N=2: interrupt between removing p2 and p1 keeps newest plain p1, confirmed e1, and published e2;
    //    orphan meta from an interrupted removeCopyWithMeta is also cleaned up on the recovery run.
    const n2Sandbox = makeSandbox();
    try {
      const [pNew, pOld] = seedBackups(n2Sandbox.backupDir, 2, {
        startDay: 2,
        encrypted: false,
        counts: { a: 10, b: 20 },
      });
      const e1 = await runWithFake(n2Sandbox, db, { BACKUP_ENCRYPT: '1' }, NOW);
      assert.equal(e1.ok, true);
      assert.equal((await runConfirmWithFake(n2Sandbox, e1.name, {}, dayPlus(1))).ok, true);
      const n2Env = envFor(n2Sandbox, db, { BACKUP_ENCRYPT: '1' });
      const e2Name = 'clickmoji-20261125T120000Z.dump.age';
      const child = launchLocked(
        n2Sandbox.backupDir,
        [
          process.execPath,
          '--input-type=module',
          '-e',
          `
          import { loadConfig } from ${JSON.stringify(path.resolve('scripts/backup/config.mjs'))};
          import { DockerRunner } from ${JSON.stringify(path.resolve('scripts/backup/docker.mjs'))};
          import { heldLock } from ${JSON.stringify(path.resolve('scripts/backup/lock.mjs'))};
          import { runBackup } from ${JSON.stringify(path.resolve('scripts/backup/pipeline.mjs'))};
          const env = ${JSON.stringify(n2Env)};
          const config = loadConfig(env);
          const lock = heldLock(config.backupDir, process.env);
          const docker = new DockerRunner({ bin: config.dockerBin, containerEnv: config.containerEnv, timeoutMs: config.dockerTimeoutMs, env });
          await runBackup({
            config, docker, lock,
            now: () => new Date(${JSON.stringify(dayPlus(24).toISOString())}),
            tempRoot: ${JSON.stringify(n2Sandbox.tmp)},
            projectRoot: ${JSON.stringify(n2Sandbox.repo)},
            onBeforePruneRemove: (old, plan) => {
              if (JSON.stringify(plan.remove) !== JSON.stringify([${JSON.stringify(pOld)}, ${JSON.stringify(pNew)}])) {
                throw new Error('unexpected plain order: ' + JSON.stringify(plan.remove));
              }
              if (old === ${JSON.stringify(pNew)}) process.kill(process.pid, 'SIGKILL');
            },
          });
          `,
        ],
        { env: n2Env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const sigN2 = await new Promise((resolve) => child.on('close', (_c, sig) => resolve(sig)));
      assert.equal(sigN2, 'SIGKILL');
      assert.equal(existsSync(path.join(n2Sandbox.backupDir, pOld)), false);
      assert.deepEqual(
        listBackups(n2Sandbox.backupDir)
          .map((e) => e.name)
          .sort(),
        [pNew, e1.name, e2Name].sort(),
        'pNew, confirmed e1, and published e2 all survive mid-cleanup interruption'
      );
      // Simulate orphan meta left by crash between rmSync(dump) and rmSync(meta)
      writeFileSync(
        path.join(n2Sandbox.backupDir, 'meta', 'clickmoji-20261119T120000Z.dump.json'),
        '{}'
      );
      assert.ok(readConfirmationState(n2Sandbox.backupDir));

      const recoveredN2 = await runWithFake(n2Sandbox, db, { BACKUP_ENCRYPT: '1' }, dayPlus(48));
      assert.equal(recoveredN2.ok, true);
      assert.deepEqual(
        listCopies(n2Sandbox.backupDir).sort(),
        [e1.name, recoveredN2.name].sort(),
        'confirmed e1 preserved alongside newest recovered copy'
      );
      assert.equal(
        existsSync(path.join(n2Sandbox.backupDir, 'meta', 'clickmoji-20261119T120000Z.dump.json')),
        false,
        'orphan meta cleaned up'
      );
      assert.equal(readConfirmationState(n2Sandbox.backupDir), null);
    } finally {
      n2Sandbox.cleanup();
    }
  });
});

describe('r2 B1-B4 regressions and integrity guards', () => {
  const dayPlus = (hours) => new Date(NOW.getTime() + hours * 3_600_000);

  it('B1: refuses confirmation when entire consistent dump+meta pair is substituted between restore and confirm', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 3,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const r1 = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, NOW);
    assert.equal(r1.ok, true);

    // Operator computes SHA-256 of snapshot A during restore.
    const r1Path = path.join(sandbox.backupDir, r1.name);
    const snapshotASha = crypto.createHash('sha256').update(readFileSync(r1Path)).digest('hex');

    // Before confirm runs, the entire consistent pair (dump + meta) at r1.name is replaced by B.
    const bodyB = 'age-encryption.org/v1\nPAIR-B-CONSISTENT\n';
    const r1MetaPath = path.join(sandbox.backupDir, 'meta', `${r1.name}.json`);
    const metaB = JSON.parse(readFileSync(r1MetaPath, 'utf8'));
    metaB.sizeBytes = Buffer.byteLength(bodyB);
    metaB.sha256 = crypto.createHash('sha256').update(bodyB).digest('hex');
    writeFileSync(r1Path, bodyB);
    writeFileSync(r1MetaPath, JSON.stringify(metaB));

    const confirmRes = await runConfirmWithFake(sandbox, r1.name, {}, dayPlus(1), {
      sha256: snapshotASha,
    });
    assert.equal(confirmRes.ok, false);
    assert.equal(confirmRes.key, 'confirmDigestMismatch');
    assert.equal(confirmRes.exit, EXIT.failed);
    assert.equal(readConfirmationState(sandbox.backupDir), null);
    assert.equal(readRecipientPolicy(sandbox.backupDir), null);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain, r1.name].sort());
  });

  it('B2: snapshots recipient bytes for container & fingerprint, locks recipient across cutover/mode-switch/restart/purge-interrupt, and protects fresh no-plaintext runs', async () => {
    // 1. Mid-run recipient file swap does not affect age input or recorded recipientSha256.
    const origRecipient = readFileSync(sandbox.recipientFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    const origRecipientSha = crypto.createHash('sha256').update(origRecipient).digest('hex');
    const swappedKey = `age1${'z'.repeat(58)}`;

    const oldPlain = seedBackups(sandbox.backupDir, 1, {
      startDay: 3,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const r1 = await runWithFake(
      sandbox,
      db,
      {
        BACKUP_ENCRYPT: '1',
        FAKE_SWAP_RECIPIENT_FILE: sandbox.recipientFile,
        FAKE_SWAP_RECIPIENT_VALUE: swappedKey,
      },
      NOW
    );
    assert.equal(r1.ok, true);
    const encryptCall = readDockerLog(sandbox).find(
      (call) => call.argv[0] === 'create' && call.argv.includes('age')
    );
    assert.equal(encryptCall.recipientUsed, origRecipient, 'age used the snapshotted recipient');
    const r1Meta = JSON.parse(
      readFileSync(path.join(sandbox.backupDir, 'meta', `${r1.name}.json`), 'utf8')
    );
    assert.equal(
      r1Meta.recipientSha256,
      origRecipientSha,
      'metadata matches snapshotted recipient'
    );
    assert.deepEqual(tempLeft(), [], 'temp recipient snapshot cleaned up');

    // Restore original recipient file and confirm r1 -> establishes durable recipient policy.
    writeFileSync(sandbox.recipientFile, `${origRecipient}\n`);
    assert.equal((await runConfirmWithFake(sandbox, r1.name, {}, dayPlus(1))).ok, true);

    // Interrupt purge mid-cutover: policy and surviving copies remain intact, recovery completes cutover.
    const n1Env = envFor(sandbox, db, { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '2' });
    const sigChild = launchLocked(
      sandbox.backupDir,
      [
        process.execPath,
        '--input-type=module',
        '-e',
        `
        import { loadConfig } from ${JSON.stringify(path.resolve('scripts/backup/config.mjs'))};
        import { DockerRunner } from ${JSON.stringify(path.resolve('scripts/backup/docker.mjs'))};
        import { heldLock } from ${JSON.stringify(path.resolve('scripts/backup/lock.mjs'))};
        import { runBackup } from ${JSON.stringify(path.resolve('scripts/backup/pipeline.mjs'))};
        const env = ${JSON.stringify(n1Env)};
        const config = loadConfig(env);
        const lock = heldLock(config.backupDir, process.env);
        const docker = new DockerRunner({ bin: config.dockerBin, containerEnv: config.containerEnv, timeoutMs: config.dockerTimeoutMs, env });
        await runBackup({
          config, docker, lock,
          now: () => new Date(${JSON.stringify(dayPlus(24).toISOString())}),
          tempRoot: ${JSON.stringify(sandbox.tmp)},
          projectRoot: ${JSON.stringify(sandbox.repo)},
          onBeforePruneRemove: () => process.kill(process.pid, 'SIGKILL'),
        });
        `,
      ],
      { env: n1Env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    assert.equal(
      await new Promise((resolve) => sigChild.on('close', (_c, sig) => resolve(sig))),
      'SIGKILL'
    );
    assert.equal(readRecipientPolicy(sandbox.backupDir)?.recipientSha256, origRecipientSha);
    assert.equal(existsSync(path.join(sandbox.backupDir, oldPlain[0])), true);

    const cutoverDone = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, dayPlus(48));
    assert.equal(cutoverDone.ok, true);
    assert.equal(existsSync(path.join(sandbox.backupDir, oldPlain[0])), false);
    assert.equal(readConfirmationState(sandbox.backupDir), null);
    assert.equal(readRecipientPolicy(sandbox.backupDir)?.recipientSha256, origRecipientSha);

    // 2. Post-cutover recipient change refuses BEFORE docker/publish/prune.
    const otherRecipientFile = path.join(sandbox.root, 'other-recipient.txt');
    writeFileSync(otherRecipientFile, `${swappedKey}\n`);
    const dockerBefore = readDockerLog(sandbox).length;
    const copiesBefore = listCopies(sandbox.backupDir);
    const rejectedChange = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_AGE_RECIPIENT_FILE: otherRecipientFile },
      dayPlus(72)
    );
    assert.equal(rejectedChange.ok, false);
    assert.equal(rejectedChange.key, 'recipientMismatch');
    assert.equal(rejectedChange.exit, EXIT.failed);
    assert.equal(readDockerLog(sandbox).length, dockerBefore, 'refused before docker');
    assert.deepEqual(listCopies(sandbox.backupDir), copiesBefore);

    // 3. Mode switch ENCRYPT=1 -> ENCRYPT=0 -> ENCRYPT=1 preserves durable recipient policy.
    const envPlain = envFor(sandbox, db);
    delete envPlain.BACKUP_ENCRYPT;
    delete envPlain.BACKUP_AGE_RECIPIENT_FILE;
    const plainRun = await startLockedRun({
      backupDir: sandbox.backupDir,
      env: envPlain,
      now: dayPlus(96),
      tempRoot: sandbox.tmp,
      projectRoot: sandbox.repo,
    }).done;
    assert.equal(plainRun.ok, true);
    assert.equal(readRecipientPolicy(sandbox.backupDir)?.recipientSha256, origRecipientSha);

    const backToWrongKey = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_AGE_RECIPIENT_FILE: otherRecipientFile },
      dayPlus(120)
    );
    assert.equal(backToWrongKey.ok, false);
    assert.equal(backToWrongKey.key, 'recipientMismatch');

    const backToOrigKey = await runWithFake(sandbox, db, { BACKUP_ENCRYPT: '1' }, dayPlus(144));
    assert.equal(backToOrigKey.ok, true);
    assert.equal(backToOrigKey.waitingForConfirmation, true);

    // 4. Fresh start WITHOUT initial plaintext protects saved copies until first identity confirmation.
    const fresh = makeSandbox();
    try {
      const f1 = await runWithFake(fresh, db, { BACKUP_ENCRYPT: '1' }, NOW);
      assert.equal(f1.ok, true);
      assert.equal(f1.waitingForConfirmation, true);
      assert.equal(f1.waitingNote, WAITING_FIRST_CONFIRMATION_NOTE);

      const f2 = await runWithFake(fresh, db, { BACKUP_ENCRYPT: '1' }, dayPlus(24));
      assert.equal(f2.ok, true);
      assert.equal(f2.waitingForConfirmation, true);
      assert.deepEqual(listCopies(fresh.backupDir).sort(), [f1.name, f2.name].sort());

      const callsBefore = readDockerLog(fresh).length;
      const f3Blocked = await runWithFake(fresh, db, { BACKUP_ENCRYPT: '1' }, dayPlus(48));
      assert.equal(f3Blocked.ok, false);
      assert.equal(f3Blocked.key, 'confirmFirstEncrypted');
      assert.equal(readDockerLog(fresh).length, callsBefore);
      assert.deepEqual(listCopies(fresh.backupDir).sort(), [f1.name, f2.name].sort());

      assert.equal((await runConfirmWithFake(fresh, f1.name, {}, dayPlus(49))).ok, true);
      const f3Ok = await runWithFake(fresh, db, { BACKUP_ENCRYPT: '1' }, dayPlus(72));
      assert.equal(f3Ok.ok, true);
      assert.equal(f3Ok.waitingForConfirmation, false);
      assert.deepEqual(listCopies(fresh.backupDir).sort(), [f2.name, f3Ok.name].sort());

      // Confirming a different recipient after policy exists is also refused (no key rotation).
      const wrongPolicySandbox = makeSandbox();
      try {
        const w1 = await runWithFake(wrongPolicySandbox, db, { BACKUP_ENCRYPT: '1' }, NOW);
        assert.equal(
          (await runConfirmWithFake(wrongPolicySandbox, w1.name, {}, dayPlus(1))).ok,
          true
        );
        const w2MetaPath = path.join(wrongPolicySandbox.backupDir, 'meta', `${w1.name}.json`);
        const w2Meta = JSON.parse(readFileSync(w2MetaPath, 'utf8'));
        w2Meta.recipientSha256 = 'b'.repeat(64);
        writeFileSync(w2MetaPath, JSON.stringify(w2Meta));
        const rejectWrongConfirm = await runConfirmWithFake(
          wrongPolicySandbox,
          w1.name,
          {},
          dayPlus(2)
        );
        assert.equal(rejectWrongConfirm.ok, false);
        assert.equal(rejectWrongConfirm.key, 'recipientMismatch');
      } finally {
        wrongPolicySandbox.cleanup();
      }
    } finally {
      fresh.cleanup();
    }
  });

  it('B3: two accepted plaintext copies with N=1 refuses early before publication across repeats while allowing confirm if .age exists', async () => {
    const twoPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 3,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const r1 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '1' },
      NOW
    );
    const r2 = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '1' },
      dayPlus(24)
    );
    assert.equal(r1.ok, false);
    assert.equal(r1.key, 'transitionLimitTooLow');
    assert.equal(r2.ok, false);
    assert.equal(r2.key, 'transitionLimitTooLow');
    assert.equal(readDockerLog(sandbox).length, 0);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...twoPlain].sort());

    // Raise N=2 to create an encrypted copy, then lower back to N=1: confirm still works!
    const encRun = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '2' },
      dayPlus(48)
    );
    assert.equal(encRun.ok, true);
    assert.equal(
      (
        await runWithFake(
          sandbox,
          db,
          { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '1' },
          dayPlus(72)
        )
      ).key,
      'transitionLimitTooLow'
    );
    assert.equal((await runConfirmWithFake(sandbox, encRun.name, {}, dayPlus(73))).ok, true);

    // After confirm, cutover at N=1 completes and keeps the confirmed encrypted copy.
    const cutover = await runWithFake(
      sandbox,
      db,
      { BACKUP_ENCRYPT: '1', BACKUP_RETENTION_COUNT: '1' },
      dayPlus(96)
    );
    assert.equal(cutover.ok, true);
    assert.deepEqual(listCopies(sandbox.backupDir), [encRun.name]);
  });

  it('B4: fails closed on non-zero truncation, same-size substitution, mid-run corruption before prune, and missing-digest records without rehashing', async () => {
    // 1. Non-zero truncation of B preserves A and B
    const [bName, aName] = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      counts: { a: 10, b: 20 },
      recipientFile: sandbox.recipientFile,
    });
    const bPath = path.join(sandbox.backupDir, bName);
    const bOrig = readFileSync(bPath, 'utf8');
    writeFileSync(bPath, bOrig.slice(0, 2)); // non-zero truncation ("ol")
    const truncRes = await runWithFake(sandbox, db);
    assert.equal(truncRes.ok, false);
    assert.equal(truncRes.key, 'corruptBackup');
    assert.equal(readDockerLog(sandbox).length, 0);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [aName, bName].sort());
    assert.equal(existsSync(path.join(sandbox.backupDir, aName)), true);

    // 2. Same-size substitution of B preserves A and B
    const sameSize = 'X'.repeat(Buffer.byteLength(bOrig));
    writeFileSync(bPath, sameSize);
    const subRes = await runWithFake(sandbox, db);
    assert.equal(subRes.ok, false);
    assert.equal(subRes.key, 'corruptBackup');
    assert.equal(readDockerLog(sandbox).length, 0);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [aName, bName].sort());

    // 3. Mid-run corruption of B between preflight and publish fails closed before pruning A
    writeFileSync(bPath, bOrig);
    const env = envFor(sandbox, db);
    const config = loadConfig(env);
    const holder = launchLocked(
      sandbox.backupDir,
      [
        process.execPath,
        '--input-type=module',
        '-e',
        `
        import { writeFileSync } from 'node:fs';
        import { loadConfig } from ${JSON.stringify(path.resolve('scripts/backup/config.mjs'))};
        import { DockerRunner } from ${JSON.stringify(path.resolve('scripts/backup/docker.mjs'))};
        import { heldLock } from ${JSON.stringify(path.resolve('scripts/backup/lock.mjs'))};
        import { runBackup, writePrivateCopy } from ${JSON.stringify(path.resolve('scripts/backup/pipeline.mjs'))};
        const env = ${JSON.stringify(env)};
        const config = loadConfig(env);
        const lock = heldLock(config.backupDir, process.env);
        const docker = new DockerRunner({ bin: config.dockerBin, containerEnv: config.containerEnv, timeoutMs: config.dockerTimeoutMs, env });
        const res = await runBackup({
          config, docker, lock,
          now: () => new Date(${JSON.stringify(NOW.toISOString())}),
          tempRoot: ${JSON.stringify(sandbox.tmp)},
          projectRoot: ${JSON.stringify(sandbox.repo)},
          publishCopy: (src, dest) => {
            // Corrupt B right before publish completes
            writeFileSync(${JSON.stringify(bPath)}, ${JSON.stringify(sameSize)});
            writePrivateCopy(src, dest);
          },
        });
        console.log(JSON.stringify(res));
        `,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    holder.stdout.on('data', (c) => {
      out += c;
    });
    await new Promise((resolve) => holder.on('close', resolve));
    const midRunRes = JSON.parse(out.trim().split('\n').pop());
    assert.equal(midRunRes.ok, false);
    assert.equal(midRunRes.key, 'corruptBackup');
    assert.equal(midRunRes.saved, true, 'newly published C remains on disk');
    assert.equal(existsSync(path.join(sandbox.backupDir, aName)), true, 'working A was NOT pruned');
    assert.equal(existsSync(bPath), true, 'B was NOT deleted');

    // 4. Old record without digest/sizeBytes fails closed without auto-rehashing metadata
    const legacyNoDigest = makeSandbox();
    try {
      const [legacyB, legacyA] = seedBackups(legacyNoDigest.backupDir, 2, {
        startDay: 2,
        counts: { a: 10, b: 20 },
        recipientFile: legacyNoDigest.recipientFile,
      });
      const legacyMetaPath = path.join(legacyNoDigest.backupDir, 'meta', `${legacyB}.json`);
      const stripped = JSON.parse(readFileSync(legacyMetaPath, 'utf8'));
      delete stripped.sha256;
      delete stripped.sizeBytes;
      const strippedRaw = JSON.stringify(stripped);
      writeFileSync(legacyMetaPath, strippedRaw);

      const noDigestRes = await runWithFake(legacyNoDigest, db);
      assert.equal(noDigestRes.ok, false);
      assert.equal(noDigestRes.key, 'corruptBackup');
      assert.equal(readFileSync(legacyMetaPath, 'utf8'), strippedRaw, 'metadata not auto-rehashed');
      assert.deepEqual(listCopies(legacyNoDigest.backupDir).sort(), [legacyA, legacyB].sort());
    } finally {
      legacyNoDigest.cleanup();
    }
  });
});
