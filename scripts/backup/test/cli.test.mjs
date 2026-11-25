// CLI tests: the real entry point as a child process, so what it prints is what we assert on.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CLI,
  lockIsFree,
  containersLeft,
  envFor,
  listCopies,
  makeProjectRepo,
  makeSandbox,
  readDockerLog,
  readStatus,
  removalEvents,
  runCli,
  seedBackups,
  seedConfirmedRecipient,
  spawnLockHolder,
  syntheticDatabase,
} from './helpers.mjs';
import {
  CONFIRMED_RECIPIENT_STATE_NAME,
  ENCRYPTED_CONFIRM_STATE_NAME,
  EXIT,
  MESSAGES,
  WAITING_CONFIRMATION_NOTE,
  WAITING_FIRST_CONFIRMATION_NOTE,
} from '../constants.mjs';

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

function assertNoSecrets(text) {
  assert.ok(!text.includes(db.password), 'password not printed');
  assert.ok(!text.includes(db.host), 'host not printed');
  assert.ok(!text.includes('postgresql://'), 'URL not printed');
}

describe('cli concurrency', () => {
  it('a run started while another process holds the lock exits busy (3), touches nothing, and says so', async () => {
    const old = seedBackups(sandbox.backupDir, 5);
    const holder = spawnLockHolder(sandbox.backupDir, path.join(sandbox.root, 'gate'));
    assert.equal(await holder.acquired, true);
    try {
      const result = await runCli(envFor(sandbox, db), [], { cli: sandbox.cli });
      assert.equal(result.code, EXIT.busy);
      assert.equal(result.stdout, `backup: ${MESSAGES.busy}\n`);
      assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
      assert.equal(readDockerLog(sandbox).length, 0, 'docker was never called');
      assert.ok(readStatus(sandbox).trimEnd().endsWith(`\t${MESSAGES.busy}`), 'status says busy');
      assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
  });
});

describe('cli failure outcomes', () => {
  it('docker unavailable: literal sanitized status, non-zero exit, old copies intact', async () => {
    const old = seedBackups(sandbox.backupDir, 20, { recipientFile: sandbox.recipientFile });
    const result = await runCli(envFor(sandbox, db, { FAKE_DOCKER_MODE: 'docker-down' }), [], {
      cli: sandbox.cli,
    });

    assert.equal(result.code, EXIT.unavailable);
    assert.notEqual(result.code, 0);
    assert.equal(readStatus(sandbox).trim().split('\t')[2], 'сбой: docker недоступен');
    assert.match(readStatus(sandbox), /\tfailed\tсбой: docker недоступен\n$/);
    assert.match(result.stdout, /сбой: docker недоступен/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
  });

  it('image pull failed: explicit status, non-zero exit, old copies intact', async () => {
    const old = seedBackups(sandbox.backupDir, 20, { recipientFile: sandbox.recipientFile });
    const result = await runCli(envFor(sandbox, db, { FAKE_DOCKER_MODE: 'pull-fail' }), [], {
      cli: sandbox.cli,
    });

    assert.equal(result.code, EXIT.unavailable);
    assert.match(readStatus(sandbox), /\tfailed\tсбой: не удалось получить образ\n$/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
    assert.deepEqual(tempLeft(), []);
  });

  it('a configuration error exits non-zero and prints no value, and writes status for missing age key when encryption is enabled', async () => {
    const env = envFor(sandbox, db);
    delete env.BACKUP_AGE_RECIPIENT_FILE;
    const result = await runCli(env, [], { cli: sandbox.cli });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /BACKUP_AGE_RECIPIENT_FILE не задан/);
    assert.match(readStatus(sandbox), /\tfailed\tсбой: BACKUP_AGE_RECIPIENT_FILE не задан\n$/);
    assert.equal(readDockerCalls(), 0, 'docker was never called');
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
  });

  it('requires explicit absolute BACKUP_DIR even when launched from outside any repository', async () => {
    const outsideCwd = path.join(sandbox.root, 'outside-cwd');
    mkdirSync(outsideCwd);
    for (const badDir of [undefined, '', 'backups', './backups']) {
      const env = envFor(sandbox, db);
      if (badDir === undefined) delete env.BACKUP_DIR;
      else env.BACKUP_DIR = badDir;
      const result = await runCli(env, [], { cwd: outsideCwd, cli: sandbox.cli });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /BACKUP_DIR/);
      assert.equal(existsSync(path.join(outsideCwd, 'backups')), false);
      assert.equal(readDockerCalls(), 0);
    }
  });

  it('default CLI run (unencrypted) succeeds without BACKUP_AGE_RECIPIENT_FILE and saves verified .dump', async () => {
    const env = envFor(sandbox, db);
    delete env.BACKUP_ENCRYPT;
    delete env.BACKUP_AGE_RECIPIENT_FILE;
    const result = await runCli(env, [], { cli: sandbox.cli });
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.match(result.stdout, /^backup: ok clickmoji-\d{8}T\d{6}Z\.dump verify=ok\n$/);
    const copies = listCopies(sandbox.backupDir);
    assert.equal(copies.length, 1);
    assert.match(copies[0], /\.dump$/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
  });

  it('rejects unknown CLI arguments', async () => {
    const result = await runCli(envFor(sandbox, db), ['--unknown-flag'], { cli: sandbox.cli });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /неизвестный параметр/);
  });

  it('a successful run prints no address, credential or count', async () => {
    seedBackups(sandbox.backupDir, 3, { recipientFile: sandbox.recipientFile });
    const result = await runCli(envFor(sandbox, db), [], { cli: sandbox.cli });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout, /^backup: ok clickmoji-\d{8}T\d{6}Z\.dump\.age verify=ok\n$/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
  });
});

describe('interruption after plaintext exists', () => {
  it('the writer SIGKILLed mid-run frees the lock at once, publishes nothing, and the next run recovers and completes', async () => {
    const old = seedBackups(sandbox.backupDir, 20, { recipientFile: sandbox.recipientFile });
    const env = envFor(sandbox, db, { FAKE_DOCKER_MODE: 'interrupt' });
    const child = spawn(process.execPath, [sandbox.cli], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    const exited = new Promise((resolve) =>
      child.on('close', (exitCode, signal) => resolve(exitCode ?? `signal:${signal}`))
    );

    assert.ok(await waitFor(() => findPlaintext(sandbox.tmp), 15_000), 'plaintext written');
    // The starter's only child is the writer: the launcher replaced itself with it.
    const writer = spawnSync('pgrep', ['-P', String(child.pid)], {
      encoding: 'utf8',
    }).stdout.trim();
    assert.match(writer, /^\d+$/, 'the writer is running');
    process.kill(Number(writer), 'SIGKILL');

    assert.equal(await exited, 128 + 9, 'the starter reports the writer was killed');
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'the kernel freed the lock at once');
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort(), 'nothing published');

    // The killed run left its container for the ledger; the next run proves it gone and completes.
    const next = await runCli(envFor(sandbox, db), [], { cli: sandbox.cli });
    assert.equal(next.code, EXIT.ok, next.stderr);
    assert.deepEqual(containersLeft(sandbox), [], 'the stale container was proven gone');
    assert.deepEqual(tempLeft(), [], 'the stale temporary directory was removed');
  });

  it('SIGTERM kills the dump container, removes plaintext and the cluster, releases the lock', async () => {
    const old = seedBackups(sandbox.backupDir, 20, { recipientFile: sandbox.recipientFile });
    const env = envFor(sandbox, db, { FAKE_DOCKER_MODE: 'interrupt' });
    const child = spawn(process.execPath, [sandbox.cli], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    // Wait until plaintext exists in the private temp directory.
    const plaintextSeen = await waitFor(() => findPlaintext(sandbox.tmp), 15_000);
    assert.ok(plaintextSeen, 'plaintext dump was written before the interruption');

    child.kill('SIGTERM');
    const code = await new Promise((resolve) =>
      child.on('close', (exitCode, signal) => resolve(exitCode ?? `signal:${signal}`))
    );

    assert.equal(code, EXIT.interrupted);
    assert.deepEqual(containersLeft(sandbox), [], 'the dump container is gone');
    const [removal] = removalEvents(sandbox);
    assert.equal(removal?.workDirExists, true, 'container removed before the plaintext directory');
    assert.equal(removal?.lockHeld, true, 'container removed before the lock is released');
    assert.equal(findPlaintext(sandbox.tmp), null, 'plaintext removed');
    assert.deepEqual(tempLeft(), [], 'temporary directory removed');
    assert.equal(await lockIsFree(sandbox.backupDir), true, 'lock released');
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort(), 'old copies intact');
    assert.match(readStatus(sandbox), /\tfailed\tсбой: прервано\n$/);
    assertNoSecrets(stdout + stderr + readStatus(sandbox));
  });
});

describe('the status file cannot alias backup data', () => {
  // Each case makes the status path point into or onto the backup tree. The run must refuse
  // before any Docker call, print nothing secret, and leave every byte of the copies as it was.
  const copyBytes = (name) => readFileSync(path.join(sandbox.backupDir, name), 'utf8');

  it('a hard link to an existing copy is refused and the copy keeps its bytes, even with docker down', async () => {
    const old = seedBackups(sandbox.backupDir, 3);
    linkSync(path.join(sandbox.backupDir, old[0]), path.join(sandbox.root, 'alias.log'));
    const before = copyBytes(old[0]);
    const result = await runCli(
      envFor(sandbox, db, {
        BACKUP_STATUS_FILE: path.join(sandbox.root, 'alias.log'),
        FAKE_DOCKER_MODE: 'docker-down',
      }),
      [],
      { cli: sandbox.cli }
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /жёсткая ссылка/);
    assert.equal(copyBytes(old[0]), before, 'copy bytes unchanged');
    assert.equal(readDockerCalls(), 0, 'docker was never called');
    assertNoSecrets(result.stdout + result.stderr);
  });

  it('a status path inside the backup directory is refused', async () => {
    const old = seedBackups(sandbox.backupDir, 2);
    const result = await runCli(
      envFor(sandbox, db, { BACKUP_STATUS_FILE: path.join(sandbox.backupDir, old[0]) }),
      [],
      { cli: sandbox.cli }
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /внутри каталога резервных копий/);
    assert.equal(readFileSync(path.join(sandbox.backupDir, old[0]), 'utf8'), 'old 1');
  });

  it('a symlink to a file outside the tree is refused and the target is not appended to', async () => {
    seedBackups(sandbox.backupDir, 1);
    const target = path.join(sandbox.root, 'elsewhere.log');
    writeFileSync(target, 'untouched\n');
    const link = path.join(sandbox.root, 'link.log');
    symlinkSync(target, link);
    const result = await runCli(envFor(sandbox, db, { BACKUP_STATUS_FILE: link }), [], {
      cli: sandbox.cli,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /символическая ссылка/);
    assert.equal(readFileSync(target, 'utf8'), 'untouched\n');
  });

  it('a symlink to a copy is refused and the copy keeps its bytes', async () => {
    const old = seedBackups(sandbox.backupDir, 2);
    const link = path.join(sandbox.root, 'link.log');
    symlinkSync(path.join(sandbox.backupDir, old[1]), link);
    const result = await runCli(envFor(sandbox, db, { BACKUP_STATUS_FILE: link }), [], {
      cli: sandbox.cli,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /внутри каталога резервных копий|символическая ссылка/);
    assert.equal(copyBytes(old[1]), 'old 2', 'copy bytes unchanged');
  });

  it('a directory whose path leads into the backup tree through a symlink is refused', async () => {
    seedBackups(sandbox.backupDir, 1);
    const alias = path.join(sandbox.root, 'alias-dir');
    symlinkSync(sandbox.backupDir, alias);
    const result = await runCli(
      envFor(sandbox, db, { BACKUP_STATUS_FILE: path.join(alias, 'status.log') }),
      [],
      { cli: sandbox.cli }
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /внутри каталога резервных копий/);
    assert.equal(existsSync(path.join(sandbox.backupDir, 'status.log')), false);
  });

  it('a status file outside the tree, not linked, is accepted as before', async () => {
    mkdirSync(path.join(sandbox.root, 'logs'));
    writeFileSync(path.join(sandbox.root, 'logs', 'status.log'), '');
    seedBackups(sandbox.backupDir, 1, { recipientFile: sandbox.recipientFile });
    const result = await runCli(
      envFor(sandbox, db, { BACKUP_STATUS_FILE: path.join(sandbox.root, 'logs', 'status.log') }),
      [],
      { cli: sandbox.cli }
    );
    assert.equal(result.code, EXIT.ok);
  });
});

describe('git check-ignore, cross-checkout launch, row-drop override and permissions via CLI', () => {
  function initRepoWithWorktree() {
    const mainRepo = path.join(sandbox.root, 'main-repo');
    const worktree = path.join(sandbox.root, 'other-worktree');
    makeProjectRepo(mainRepo, { copyScripts: true });
    assert.equal(
      spawnSync('git', ['-C', mainRepo, 'worktree', 'add', '-q', worktree, '-b', 'wt']).status,
      0
    );
    return {
      mainRepo,
      worktree,
      worktreeCli: path.join(worktree, 'scripts', 'backup', 'cli.mjs'),
    };
  }

  it('succeeds from a linked worktree into main repo gitignored backups/, prunes 10 to 2, and keeps git status clean', async () => {
    const { mainRepo, worktree, worktreeCli } = initRepoWithWorktree();
    const targetBackups = path.join(mainRepo, 'backups');
    seedBackups(targetBackups, 10, { encrypted: false });

    const env = envFor(sandbox, db, { BACKUP_DIR: targetBackups });
    delete env.BACKUP_ENCRYPT;
    delete env.BACKUP_AGE_RECIPIENT_FILE;

    const result = await runCli(env, [], { cwd: worktree, cli: worktreeCli });
    assert.equal(result.code, EXIT.ok, result.stderr + result.stdout);
    assert.equal(listCopies(targetBackups).length, 2, '10 fixtures + new copy pruned to 2 newest');
    assert.equal(existsSync(path.join(worktree, 'backups')), false, 'no backups dir in worktree');

    const mainStatus = spawnSync('git', ['-C', mainRepo, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(mainStatus.stdout, '', 'destination repo git status is completely clean');
    const wtStatus = spawnSync('git', ['-C', worktree, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(wtStatus.stdout, '', 'worktree git status is completely clean');
  });

  it('B4: rejects linked worktree own backups/, foreign repo, and external path with reason and creates nothing', async () => {
    const { worktree, worktreeCli } = initRepoWithWorktree();
    const { backupDir: foreignBackups } = makeProjectRepo(path.join(sandbox.root, 'foreign-repo'), {
      copyScripts: false,
    });
    const externalBackups = path.join(sandbox.root, 'external-backups');

    for (const [label, badDir] of [
      ['linked worktree own backups/', path.join(worktree, 'backups')],
      ['foreign repository backups/', foreignBackups],
      ['external path outside git', externalBackups],
    ]) {
      const env = envFor(sandbox, db, { BACKUP_DIR: badDir });
      const result = await runCli(env, [], { cwd: worktree, cli: worktreeCli });
      assert.equal(result.code, EXIT.failed, `${label} must fail`);
      assert.match(result.stdout, /backups\/ основной копии проекта/, label);
      assert.match(
        readStatus(sandbox),
        new RegExp(`\\tfailed\\t${MESSAGES.notMainBackups}\\n$`),
        label
      );
      assert.equal(existsSync(badDir), false, `${label}: directory not created`);
    }
    assert.equal(readDockerCalls(), 0, 'docker was never called');

    // Also verify the repository's own CLI rejects an external path directly without env overrides.
    const realExternal = await runCli(
      envFor(sandbox, db, { BACKUP_DIR: path.join(sandbox.root, 'real-external') }),
      [],
      { cli: CLI }
    );
    assert.equal(realExternal.code, EXIT.failed);
    assert.match(realExternal.stdout, /backups\/ основной копии проекта/);
    assert.equal(existsSync(path.join(sandbox.root, 'real-external')), false);
    assert.equal(readDockerCalls(), 0);
  });

  it('refuses non-ignored main backups/ path with status reason and creates nothing', async () => {
    const { mainRepo, worktree, worktreeCli } = initRepoWithWorktree();
    writeFileSync(path.join(mainRepo, '.gitignore'), '');
    assert.equal(spawnSync('git', ['-C', mainRepo, 'add', '.gitignore']).status, 0);
    assert.equal(
      spawnSync('git', [
        '-C',
        mainRepo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@e.invalid',
        'commit',
        '-q',
        '-m',
        'drop ignore',
      ]).status,
      0
    );
    const targetBackups = path.join(mainRepo, 'backups');
    const env = envFor(sandbox, db, { BACKUP_DIR: targetBackups });

    const result = await runCli(env, [], { cwd: worktree, cli: worktreeCli });
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stdout, /не игнорируется git/);
    assert.match(
      readStatus(sandbox),
      /\tfailed\tсбой: каталог резервных копий не игнорируется git\n$/
    );
    assert.equal(existsSync(targetBackups), false, 'non-ignored dir was not created');
    assert.equal(readDockerCalls(), 0, 'docker was never called');
    const mainStatus = spawnSync('git', ['-C', mainRepo, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(mainStatus.stdout, '', 'destination repo remains clean');
  });

  it('B3 CLI: /backups/* with targeted !/backups/<real-name> rejects with status, preserves old copies, and keeps git status clean', async () => {
    const old = seedBackups(sandbox.backupDir, 2, { encrypted: false });
    const exactName = 'clickmoji-20261124T120000Z.dump';
    writeFileSync(path.join(sandbox.repo, '.gitignore'), `/backups/*\n!/backups/${exactName}\n`);
    assert.equal(spawnSync('git', ['-C', sandbox.repo, 'add', '.gitignore']).status, 0);
    assert.equal(
      spawnSync('git', [
        '-C',
        sandbox.repo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@e.invalid',
        'commit',
        '-q',
        '-m',
        'targeted negation',
      ]).status,
      0
    );

    const env = envFor(sandbox, db);
    delete env.BACKUP_ENCRYPT;
    delete env.BACKUP_AGE_RECIPIENT_FILE;

    // Run real CLI subprocess (starter + locked writer) with deterministic clock preload so the
    // exact generated filename hits !/backups/<exactName>.
    const preload = path.join(sandbox.root, 'fixed-clock-preload.mjs');
    writeFileSync(
      preload,
      `const RealDate = Date;
const fixed = new RealDate('2026-11-24T12:00:00.000Z').getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length === 0 ? [fixed] : args)); }
  static now() { return fixed; }
};
`
    );
    env.NODE_OPTIONS = `--import=${preload}`;
    const run = await runCli(env, [], { cli: sandbox.cli });
    assert.equal(run.code, EXIT.failed, run.stderr + run.stdout);
    assert.match(run.stdout, /не игнорируется git/);
    assert.match(
      readStatus(sandbox),
      /\tfailed\tсбой: каталог резервных копий не игнорируется git\n$/
    );
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
    assert.equal(existsSync(path.join(sandbox.backupDir, exactName)), false);
    const repoStatus = spawnSync('git', ['-C', sandbox.repo, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(repoStatus.stdout, '', 'git status remains completely clean');
  });

  it('refuses when git is unavailable with status reason and creates no copy', async () => {
    const { mainRepo, worktreeCli } = initRepoWithWorktree();
    const targetBackups = path.join(mainRepo, 'backups');
    const env = envFor(sandbox, db, {
      BACKUP_DIR: targetBackups,
      BACKUP_GIT_BIN: '/nonexistent/git-binary',
    });
    const result = await runCli(env, [], { cli: worktreeCli });
    assert.equal(result.code, EXIT.unavailable);
    assert.match(result.stdout, /git недоступен/);
    assert.match(readStatus(sandbox), /\tfailed\tсбой: git недоступен\n$/);
    assert.equal(existsSync(targetBackups), false, 'backup dir was not created');
    assert.equal(readDockerCalls(), 0);
  });

  it('CLI row-drop rejection preserves both old copies and --allow-row-drop accepts and updates baseline', async () => {
    const old = seedBackups(sandbox.backupDir, 2, {
      startDay: 10,
      counts: { a: 100, b: 100 },
      recipientFile: sandbox.recipientFile,
    });
    const env = envFor(sandbox, db, { FAKE_COUNTS: '{"a":10,"b":100}' });

    const rejected = await runCli(env, [], { cli: sandbox.cli });
    assert.equal(rejected.code, EXIT.suspicious);
    assert.match(rejected.stdout, /число строк упало более чем на 20%/);
    assert.match(readStatus(sandbox), /\tfailed\tсбой: число строк упало более чем на 20%\n$/);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());

    const confirmed = await runCli(env, ['--allow-row-drop'], { cli: sandbox.cli });
    assert.equal(confirmed.code, EXIT.ok, confirmed.stderr + confirmed.stdout);
    const afterConfirm = listCopies(sandbox.backupDir);
    assert.equal(afterConfirm.length, 2);
    assert.ok(afterConfirm.includes(old[0]), 'newest prior copy kept');

    // Wait 1 second so the next CLI invocation gets a distinct timestamp.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const followUp = await runCli(env, [], { cli: sandbox.cli });
    assert.equal(followUp.code, EXIT.ok, followUp.stderr + followUp.stdout);
    assert.equal(listCopies(sandbox.backupDir).length, 2);
  });

  it('enforces 0700 on existing backupDir and 0600 on files via CLI under permissive umask', async () => {
    mkdirSync(sandbox.backupDir, { recursive: true, mode: 0o755 });
    chmodSync(sandbox.backupDir, 0o755);
    const env = envFor(sandbox, db);
    delete env.BACKUP_ENCRYPT;
    delete env.BACKUP_AGE_RECIPIENT_FILE;

    const runner = path.join(sandbox.root, 'umask-cli.mjs');
    writeFileSync(
      runner,
      `process.umask(0o000);\nconst { main } = await import(${JSON.stringify(sandbox.cli)});\nprocess.exitCode = await main(process.env, []);\n`
    );
    const run = spawnSync(process.execPath, [runner], { env, encoding: 'utf8' });
    assert.equal(run.status, EXIT.ok, run.stderr + run.stdout);
    assert.equal(statSync(sandbox.backupDir).mode & 0o777, 0o700);
    const [copy] = listCopies(sandbox.backupDir);
    assert.ok(copy);
    assert.equal(statSync(path.join(sandbox.backupDir, copy)).mode & 0o777, 0o600);
    assert.equal(
      statSync(path.join(sandbox.backupDir, 'meta', `${copy}.json`)).mode & 0o777,
      0o600
    );
  });
});

describe('B2 CLI explicit confirmation and transition flow', () => {
  it('end-to-end CLI flow: unconfirmed encrypted runs keep plain dumps with waiting note; --confirm-encrypted-restore works without DB/keys and deletes nothing; next encrypted run purges plain dumps', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });

    // First encrypted run via CLI keeps oldPlain and prints waiting reminder
    const first = await runCli(envFor(sandbox, db), [], { cli: sandbox.cli });
    assert.equal(first.code, EXIT.ok, first.stderr + first.stdout);
    assert.match(first.stdout, new RegExp(WAITING_CONFIRMATION_NOTE));
    assert.match(readStatus(sandbox), new RegExp(WAITING_CONFIRMATION_NOTE));
    const afterFirst = listCopies(sandbox.backupDir);
    assert.equal(afterFirst.length, 3);
    const enc1 = afterFirst.find((name) => name.endsWith('.dump.age'));
    assert.ok(enc1);

    // Explicit confirmation without DATABASE_URL, BACKUP_ENCRYPT, or BACKUP_AGE_RECIPIENT_FILE
    const enc1Sha = crypto
      .createHash('sha256')
      .update(readFileSync(path.join(sandbox.backupDir, enc1)))
      .digest('hex');
    const confirmEnv = {
      PATH: process.env.PATH,
      BACKUP_DIR: sandbox.backupDir,
      BACKUP_STATUS_FILE: sandbox.statusFile,
    };
    const dockerCallsBefore = readDockerCalls();
    const confirmed = await runCli(
      confirmEnv,
      ['--confirm-encrypted-restore', enc1, '--sha256', enc1Sha],
      {
        cli: sandbox.cli,
      }
    );
    assert.equal(confirmed.code, EXIT.ok, confirmed.stderr + confirmed.stdout);
    assert.match(confirmed.stdout, new RegExp(`confirmed encrypted restore ${enc1}`));
    assert.equal(readDockerCalls(), dockerCallsBefore, 'no docker called during confirmation');
    assert.deepEqual(
      listCopies(sandbox.backupDir).sort(),
      [...oldPlain, enc1].sort(),
      'confirmation deletes nothing'
    );
    const statePath = path.join(sandbox.backupDir, 'meta', ENCRYPTED_CONFIRM_STATE_NAME);
    const policyPath = path.join(sandbox.backupDir, 'meta', CONFIRMED_RECIPIENT_STATE_NAME);
    assert.equal(existsSync(statePath), true);
    assert.equal(existsSync(policyPath), true);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    assert.equal(statSync(policyPath).mode & 0o777, 0o600);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.file, enc1);
    assert.equal(state.sha256, enc1Sha);
    assert.match(state.confirmedAt, /^\d{4}-\d{2}-\d{2}T/);

    // Wait 1.1s so next CLI run gets a distinct second timestamp
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await runCli(envFor(sandbox, db), [], { cli: sandbox.cli });
    assert.equal(second.code, EXIT.ok, second.stderr + second.stdout);
    assert.doesNotMatch(second.stdout, new RegExp(WAITING_CONFIRMATION_NOTE));
    const finalCopies = listCopies(sandbox.backupDir);
    assert.equal(finalCopies.length, 2, 'returned to retention limit N=2');
    assert.ok(finalCopies.every((name) => name.endsWith('.dump.age')));
    for (const p of oldPlain) assert.equal(existsSync(path.join(sandbox.backupDir, p)), false);
    assert.equal(existsSync(statePath), false);
    assert.equal(existsSync(policyPath), true, 'durable recipient policy survives cutover');
  });

  it('rejects missing, unencrypted, foreign, incomplete, tampered, and symlinked artifacts without writing confirmation or deleting anything', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 1, { startDay: 3, encrypted: false });
    const [validEnc] = seedBackups(sandbox.backupDir, 1, { startDay: 1, encrypted: true });
    const validSha = crypto
      .createHash('sha256')
      .update(readFileSync(path.join(sandbox.backupDir, validEnc)))
      .digest('hex');
    const orphanEnc = 'clickmoji-20261124T010000Z.dump.age';
    writeFileSync(path.join(sandbox.backupDir, orphanEnc), 'ORPHAN');
    const tamperedEnc = 'clickmoji-20261124T020000Z.dump.age';
    writeFileSync(path.join(sandbox.backupDir, tamperedEnc), 'ACTUAL');
    writeFileSync(
      path.join(sandbox.backupDir, 'meta', `${tamperedEnc}.json`),
      JSON.stringify({
        name: tamperedEnc,
        encrypted: true,
        sizeBytes: 6,
        sha256: '0'.repeat(64),
        verify: 'ok',
        counts: {},
      })
    );
    const symlinkEnc = 'clickmoji-20261124T030000Z.dump.age';
    symlinkSync(path.join(sandbox.backupDir, validEnc), path.join(sandbox.backupDir, symlinkEnc));

    const confirmEnv = {
      PATH: process.env.PATH,
      BACKUP_DIR: sandbox.backupDir,
      BACKUP_STATUS_FILE: sandbox.statusFile,
    };
    const statePath = path.join(sandbox.backupDir, 'meta', ENCRYPTED_CONFIRM_STATE_NAME);

    // Missing --sha256 is rejected at CLI argument parsing
    const missingSha = await runCli(confirmEnv, ['--confirm-encrypted-restore', validEnc], {
      cli: sandbox.cli,
    });
    assert.equal(missingSha.code, EXIT.failed);
    assert.match(missingSha.stderr, /--sha256/);
    assert.equal(existsSync(statePath), false);

    for (const badTarget of [
      'clickmoji-20261124T099999Z.dump.age', // missing / bad stamp
      'clickmoji-20261120T000000Z.dump.age', // missing
      oldPlain[0], // unencrypted .dump
      `../${validEnc}`, // path traversal / foreign
      path.join(sandbox.backupDir, validEnc), // absolute path instead of filename
      orphanEnc, // incomplete (no meta)
      tamperedEnc, // sha256 mismatch
      symlinkEnc, // symlink
    ]) {
      const res = await runCli(
        confirmEnv,
        ['--confirm-encrypted-restore', badTarget, '--sha256', validSha],
        {
          cli: sandbox.cli,
        }
      );
      assert.equal(res.code, EXIT.failed, `must reject ${badTarget}`);
      assert.equal(existsSync(statePath), false, `no state written for ${badTarget}`);
      assert.equal(existsSync(path.join(sandbox.backupDir, oldPlain[0])), true);
    }
  });

  it('enforces early Git guard (disabled git, non-ignored state path, non-main backups) and shared lock on --confirm-encrypted-restore', async () => {
    const [enc] = seedBackups(sandbox.backupDir, 1, { startDay: 1, encrypted: true });
    const encSha = crypto
      .createHash('sha256')
      .update(readFileSync(path.join(sandbox.backupDir, enc)))
      .digest('hex');
    const confirmEnv = {
      PATH: process.env.PATH,
      BACKUP_DIR: sandbox.backupDir,
      BACKUP_STATUS_FILE: sandbox.statusFile,
    };
    const statePath = path.join(sandbox.backupDir, 'meta', ENCRYPTED_CONFIRM_STATE_NAME);

    // 1. Git unavailable -> exit 4, writes status, no state file
    const noGit = await runCli(
      { ...confirmEnv, BACKUP_GIT_BIN: '/nonexistent/git-bin' },
      ['--confirm-encrypted-restore', enc, '--sha256', encSha],
      { cli: sandbox.cli }
    );
    assert.equal(noGit.code, EXIT.unavailable);
    assert.match(readStatus(sandbox), /\tfailed\tсбой: git недоступен\n$/);
    assert.equal(existsSync(statePath), false);

    // 2. Targeted negation on confirmation state file -> exit 1, writes status, clean git status
    writeFileSync(
      path.join(sandbox.repo, '.gitignore'),
      `/backups/*\n!/backups/meta/\n!/backups/meta/${ENCRYPTED_CONFIRM_STATE_NAME}\n`
    );
    assert.equal(spawnSync('git', ['-C', sandbox.repo, 'add', '.gitignore']).status, 0);
    assert.equal(
      spawnSync('git', [
        '-C',
        sandbox.repo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@e.invalid',
        'commit',
        '-q',
        '-m',
        'negate confirm state',
      ]).status,
      0
    );
    const notIgnored = await runCli(
      confirmEnv,
      ['--confirm-encrypted-restore', enc, '--sha256', encSha],
      {
        cli: sandbox.cli,
      }
    );
    assert.equal(notIgnored.code, EXIT.failed);
    assert.match(notIgnored.stdout, /не игнорируется git/);
    assert.equal(existsSync(statePath), false);

    // Restore /backups/ ignore and test busy lock -> exit 3
    writeFileSync(path.join(sandbox.repo, '.gitignore'), '/backups/\n');
    const holder = spawnLockHolder(sandbox.backupDir, path.join(sandbox.root, 'gate'));
    assert.equal(await holder.acquired, true);
    try {
      const busy = await runCli(
        confirmEnv,
        ['--confirm-encrypted-restore', enc, '--sha256', encSha],
        {
          cli: sandbox.cli,
        }
      );
      assert.equal(busy.code, EXIT.busy);
      assert.equal(existsSync(statePath), false);
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
  });

  it('repeated unconfirmed CLI run at N=2 caps at N+1 and reports kept first .age without claiming deleted copy was saved', async () => {
    const oldPlain = seedBackups(sandbox.backupDir, 2, {
      startDay: 2,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const first = await runCli(envFor(sandbox, db), [], { cli: sandbox.cli });
    assert.equal(first.code, EXIT.ok, first.stderr + first.stdout);
    const enc1 = listCopies(sandbox.backupDir).find((name) => name.endsWith('.dump.age'));
    assert.ok(enc1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const repeat = await runCli(envFor(sandbox, db), [], { cli: sandbox.cli });
    assert.equal(repeat.code, EXIT.ok, repeat.stderr + repeat.stdout);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...oldPlain, enc1].sort());
    assert.match(
      repeat.stdout,
      new RegExp(
        `^backup: ok verify=ok decrypt=unconfirmed kept=${enc1} new=pruned \\(${WAITING_CONFIRMATION_NOTE}\\)\n$`
      )
    );
    const lastStatus = readStatus(sandbox).trim().split('\n').pop();
    assert.match(
      lastStatus,
      new RegExp(
        `verify=ok decrypt=unconfirmed kept=${enc1} new=pruned prune=ok \\(${WAITING_CONFIRMATION_NOTE}\\)$`
      )
    );
  });

  it('N=1 CLI cutover flow prioritizes confirmed ciphertext and clears plain copy and confirmation state', async () => {
    const [p1] = seedBackups(sandbox.backupDir, 1, {
      startDay: 2,
      encrypted: false,
      counts: { a: 10, b: 20 },
    });
    const envN1 = envFor(sandbox, db, { BACKUP_RETENTION_COUNT: '1' });
    const first = await runCli(envN1, [], { cli: sandbox.cli });
    assert.equal(first.code, EXIT.ok, first.stderr + first.stdout);
    const enc1 = listCopies(sandbox.backupDir).find((name) => name.endsWith('.dump.age'));
    assert.ok(enc1);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [p1, enc1].sort());

    const enc1Sha = crypto
      .createHash('sha256')
      .update(readFileSync(path.join(sandbox.backupDir, enc1)))
      .digest('hex');
    const confirm = await runCli(
      {
        PATH: process.env.PATH,
        BACKUP_DIR: sandbox.backupDir,
        BACKUP_STATUS_FILE: sandbox.statusFile,
      },
      ['--confirm-encrypted-restore', enc1, '--sha256', enc1Sha],
      { cli: sandbox.cli }
    );
    assert.equal(confirm.code, EXIT.ok, confirm.stderr + confirm.stdout);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const cutover = await runCli(envN1, [], { cli: sandbox.cli });
    assert.equal(cutover.code, EXIT.ok, cutover.stderr + cutover.stdout);
    assert.deepEqual(listCopies(sandbox.backupDir), [enc1]);
    assert.equal(existsSync(path.join(sandbox.backupDir, p1)), false);
    assert.equal(
      existsSync(path.join(sandbox.backupDir, 'meta', ENCRYPTED_CONFIRM_STATE_NAME)),
      false
    );
    assert.match(cutover.stdout, new RegExp(`^backup: ok verify=ok kept=${enc1} new=pruned\n$`));
    const lastStatus = readStatus(sandbox).trim().split('\n').pop();
    assert.match(lastStatus, new RegExp(`verify=ok kept=${enc1} new=pruned prune=ok$`));
  });

  it('r2 CLI B1/B2/B3/B4: digest-bound confirm, recipient policy lock, N=1 plain-transition preflight refusal, and integrity checks', async () => {
    // B1: replacing consistent dump+meta pair between restore (sha256 A) and CLI confirm rejects under lock
    const b1Plain = seedBackups(sandbox.backupDir, 1, { startDay: 3, encrypted: false });
    const b1EncRes = await runCli(envFor(sandbox, db), [], { cli: sandbox.cli });
    assert.equal(b1EncRes.code, EXIT.ok);
    const b1Enc = listCopies(sandbox.backupDir).find((n) => n.endsWith('.dump.age'));
    const restoredSnapshotSha = crypto
      .createHash('sha256')
      .update(readFileSync(path.join(sandbox.backupDir, b1Enc)))
      .digest('hex');

    // Substitute entire consistent pair (dump + meta) under the same filename
    const pairB = 'age-encryption.org/v1\nSUBSTITUTED-CONSISTENT-PAIR\n';
    const pairBMetaPath = path.join(sandbox.backupDir, 'meta', `${b1Enc}.json`);
    const pairBMeta = JSON.parse(readFileSync(pairBMetaPath, 'utf8'));
    pairBMeta.sizeBytes = Buffer.byteLength(pairB);
    pairBMeta.sha256 = crypto.createHash('sha256').update(pairB).digest('hex');
    writeFileSync(path.join(sandbox.backupDir, b1Enc), pairB);
    writeFileSync(pairBMetaPath, JSON.stringify(pairBMeta));

    const b1Rejected = await runCli(
      {
        PATH: process.env.PATH,
        BACKUP_DIR: sandbox.backupDir,
        BACKUP_STATUS_FILE: sandbox.statusFile,
      },
      ['--confirm-encrypted-restore', b1Enc, '--sha256', restoredSnapshotSha],
      { cli: sandbox.cli }
    );
    assert.equal(b1Rejected.code, EXIT.failed);
    assert.match(b1Rejected.stdout, new RegExp(MESSAGES.confirmDigestMismatch));
    assert.equal(
      existsSync(path.join(sandbox.backupDir, 'meta', ENCRYPTED_CONFIRM_STATE_NAME)),
      false
    );
    assert.equal(existsSync(path.join(sandbox.backupDir, b1Plain[0])), true);

    // B3: 2 accepted plain dumps + N=1 refuses early before docker, repeats preserve both, and confirm still works if .age exists
    const b3Sandbox = makeSandbox();
    try {
      const twoPlain = seedBackups(b3Sandbox.backupDir, 2, { startDay: 2, encrypted: false });
      const envN1 = envFor(b3Sandbox, db, { BACKUP_RETENTION_COUNT: '1' });
      const r1 = await runCli(envN1, [], { cli: b3Sandbox.cli });
      const r2 = await runCli(envN1, [], { cli: b3Sandbox.cli });
      assert.equal(r1.code, EXIT.failed);
      assert.equal(r2.code, EXIT.failed);
      assert.match(r1.stdout, /BACKUP_RETENTION_COUNT/);
      assert.deepEqual(listCopies(b3Sandbox.backupDir).sort(), [...twoPlain].sort());
      assert.equal(
        existsSync(b3Sandbox.logFile)
          ? readFileSync(b3Sandbox.logFile, 'utf8').split('\n').filter(Boolean).length
          : 0,
        0,
        'no docker call on early B3 preflight refusal'
      );

      // Temporarily raise N=2 to create .age, then drop back to N=1: confirm still succeeds!
      const withN2 = await runCli(envFor(b3Sandbox, db, { BACKUP_RETENTION_COUNT: '2' }), [], {
        cli: b3Sandbox.cli,
      });
      assert.equal(withN2.code, EXIT.ok);
      const encFile = listCopies(b3Sandbox.backupDir).find((n) => n.endsWith('.dump.age'));
      const encSha = crypto
        .createHash('sha256')
        .update(readFileSync(path.join(b3Sandbox.backupDir, encFile)))
        .digest('hex');
      // Still refuses backup run at N=1 before confirm
      assert.equal((await runCli(envN1, [], { cli: b3Sandbox.cli })).code, EXIT.failed);
      // Confirm succeeds even while N=1 (loadConfirmConfig ignores N)
      const conf = await runCli(
        {
          PATH: process.env.PATH,
          BACKUP_DIR: b3Sandbox.backupDir,
          BACKUP_STATUS_FILE: b3Sandbox.statusFile,
        },
        ['--confirm-encrypted-restore', encFile, '--sha256', encSha],
        { cli: b3Sandbox.cli }
      );
      assert.equal(conf.code, EXIT.ok);
    } finally {
      b3Sandbox.cleanup();
    }

    // B2 no-plaintext fresh mode + post-confirmation recipient lock + B4 CLI truncation check
    const b2Fresh = makeSandbox();
    try {
      const envN1 = envFor(b2Fresh, db, { BACKUP_RETENTION_COUNT: '1' });
      const first = await runCli(envN1, [], { cli: b2Fresh.cli });
      assert.equal(first.code, EXIT.ok);
      assert.match(first.stdout, new RegExp(WAITING_FIRST_CONFIRMATION_NOTE));
      const [enc1] = listCopies(b2Fresh.backupDir);

      // Second run at N=1 refuses before evicting unconfirmed enc1
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const blockedEvict = await runCli(envN1, [], { cli: b2Fresh.cli });
      assert.equal(blockedEvict.code, EXIT.failed);
      assert.match(blockedEvict.stdout, new RegExp(MESSAGES.confirmFirstEncrypted));
      assert.deepEqual(listCopies(b2Fresh.backupDir), [enc1]);

      // Confirm enc1 with snapshot SHA-256
      const enc1Sha = crypto
        .createHash('sha256')
        .update(readFileSync(path.join(b2Fresh.backupDir, enc1)))
        .digest('hex');
      const okConfirm = await runCli(
        {
          PATH: process.env.PATH,
          BACKUP_DIR: b2Fresh.backupDir,
          BACKUP_STATUS_FILE: b2Fresh.statusFile,
        },
        ['--confirm-encrypted-restore', enc1, '--sha256', enc1Sha],
        { cli: b2Fresh.cli }
      );
      assert.equal(okConfirm.code, EXIT.ok);

      // Changing recipient after confirmation fails closed before docker
      const otherKey = path.join(b2Fresh.root, 'other.txt');
      writeFileSync(otherKey, `age1${'p'.repeat(58)}\n`);
      const wrongRec = await runCli(
        envFor(b2Fresh, db, { BACKUP_RETENTION_COUNT: '1', BACKUP_AGE_RECIPIENT_FILE: otherKey }),
        [],
        { cli: b2Fresh.cli }
      );
      assert.equal(wrongRec.code, EXIT.failed);
      assert.match(wrongRec.stdout, new RegExp(MESSAGES.recipientMismatch));
      assert.deepEqual(listCopies(b2Fresh.backupDir), [enc1]);

      // B4: same-size substitution on enc1 fails closed via CLI
      const origLen = readFileSync(path.join(b2Fresh.backupDir, enc1)).length;
      writeFileSync(path.join(b2Fresh.backupDir, enc1), 'X'.repeat(origLen));
      const corruptCli = await runCli(envN1, [], { cli: b2Fresh.cli });
      assert.equal(corruptCli.code, EXIT.failed);
      assert.match(corruptCli.stdout, new RegExp(MESSAGES.corruptBackup));
      assert.deepEqual(listCopies(b2Fresh.backupDir), [enc1]);
    } finally {
      b2Fresh.cleanup();
    }
  });
});

function readDockerCalls() {
  return existsSync(sandbox.logFile)
    ? readFileSync(sandbox.logFile, 'utf8').split('\n').filter(Boolean).length
    : 0;
}

// Looks for the plaintext dump inside any clickmoji-backup-* directory under the sandbox temp.
function findPlaintext(tmp) {
  for (const entry of readdirSync(tmp)) {
    if (!entry.startsWith('clickmoji-backup-')) continue;
    const file = path.join(tmp, entry, 'dump.custom');
    try {
      if (statSync(file).size > 0) return file;
    } catch {
      // Not written yet.
    }
  }
  return null;
}

async function waitFor(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}
