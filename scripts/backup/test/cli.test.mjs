// CLI tests: the real entry point as a child process, so what it prints is what we assert on.
import assert from 'node:assert/strict';
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
  makeSandbox,
  readDockerLog,
  readStatus,
  removalEvents,
  runCli,
  seedBackups,
  spawnLockHolder,
  syntheticDatabase,
} from './helpers.mjs';
import { EXIT, MESSAGES } from '../constants.mjs';

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
      const result = await runCli(envFor(sandbox, db));
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
    const old = seedBackups(sandbox.backupDir, 20);
    const result = await runCli(envFor(sandbox, db, { FAKE_DOCKER_MODE: 'docker-down' }));

    assert.equal(result.code, EXIT.unavailable);
    assert.notEqual(result.code, 0);
    assert.equal(readStatus(sandbox).trim().split('\t')[2], 'сбой: docker недоступен');
    assert.match(readStatus(sandbox), /\tfailed\tсбой: docker недоступен\n$/);
    assert.match(result.stdout, /сбой: docker недоступен/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
  });

  it('image pull failed: explicit status, non-zero exit, old copies intact', async () => {
    const old = seedBackups(sandbox.backupDir, 20);
    const result = await runCli(envFor(sandbox, db, { FAKE_DOCKER_MODE: 'pull-fail' }));

    assert.equal(result.code, EXIT.unavailable);
    assert.match(readStatus(sandbox), /\tfailed\tсбой: не удалось получить образ\n$/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());
    assert.deepEqual(tempLeft(), []);
  });

  it('a configuration error exits non-zero and prints no value, and writes status for missing age key when encryption is enabled', async () => {
    const env = envFor(sandbox, db);
    delete env.BACKUP_AGE_RECIPIENT_FILE;
    const result = await runCli(env);
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
      const result = await runCli(env, [], { cwd: outsideCwd });
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
    const result = await runCli(env);
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.match(result.stdout, /^backup: ok clickmoji-\d{8}T\d{6}Z\.dump verify=ok\n$/);
    const copies = listCopies(sandbox.backupDir);
    assert.equal(copies.length, 1);
    assert.match(copies[0], /\.dump$/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
  });

  it('rejects unknown CLI arguments', async () => {
    const result = await runCli(envFor(sandbox, db), ['--unknown-flag']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /неизвестный параметр/);
  });

  it('a successful run prints no address, credential or count', async () => {
    seedBackups(sandbox.backupDir, 3);
    const result = await runCli(envFor(sandbox, db));
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout, /^backup: ok clickmoji-\d{8}T\d{6}Z\.dump\.age verify=ok\n$/);
    assertNoSecrets(result.stdout + result.stderr + readStatus(sandbox));
  });
});

describe('interruption after plaintext exists', () => {
  it('the writer SIGKILLed mid-run frees the lock at once, publishes nothing, and the next run recovers and completes', async () => {
    const old = seedBackups(sandbox.backupDir, 20);
    const env = envFor(sandbox, db, { FAKE_DOCKER_MODE: 'interrupt' });
    const child = spawn(process.execPath, [CLI], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const next = await runCli(envFor(sandbox, db));
    assert.equal(next.code, EXIT.ok, next.stderr);
    assert.deepEqual(containersLeft(sandbox), [], 'the stale container was proven gone');
    assert.deepEqual(tempLeft(), [], 'the stale temporary directory was removed');
  });

  it('SIGTERM kills the dump container, removes plaintext and the cluster, releases the lock', async () => {
    const old = seedBackups(sandbox.backupDir, 20);
    const env = envFor(sandbox, db, { FAKE_DOCKER_MODE: 'interrupt' });
    const child = spawn(process.execPath, [CLI], {
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
      })
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
      envFor(sandbox, db, { BACKUP_STATUS_FILE: path.join(sandbox.backupDir, old[0]) })
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
    const result = await runCli(envFor(sandbox, db, { BACKUP_STATUS_FILE: link }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /символическая ссылка/);
    assert.equal(readFileSync(target, 'utf8'), 'untouched\n');
  });

  it('a symlink to a copy is refused and the copy keeps its bytes', async () => {
    const old = seedBackups(sandbox.backupDir, 2);
    const link = path.join(sandbox.root, 'link.log');
    symlinkSync(path.join(sandbox.backupDir, old[1]), link);
    const result = await runCli(envFor(sandbox, db, { BACKUP_STATUS_FILE: link }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /внутри каталога резервных копий|символическая ссылка/);
    assert.equal(copyBytes(old[1]), 'old 2', 'copy bytes unchanged');
  });

  it('a directory whose path leads into the backup tree through a symlink is refused', async () => {
    seedBackups(sandbox.backupDir, 1);
    const alias = path.join(sandbox.root, 'alias-dir');
    symlinkSync(sandbox.backupDir, alias);
    const result = await runCli(
      envFor(sandbox, db, { BACKUP_STATUS_FILE: path.join(alias, 'status.log') })
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /внутри каталога резервных копий/);
    assert.equal(existsSync(path.join(sandbox.backupDir, 'status.log')), false);
  });

  it('a status file outside the tree, not linked, is accepted as before', async () => {
    mkdirSync(path.join(sandbox.root, 'logs'));
    writeFileSync(path.join(sandbox.root, 'logs', 'status.log'), '');
    seedBackups(sandbox.backupDir, 1);
    const result = await runCli(
      envFor(sandbox, db, { BACKUP_STATUS_FILE: path.join(sandbox.root, 'logs', 'status.log') })
    );
    assert.equal(result.code, EXIT.ok);
  });
});

describe('git check-ignore, cross-checkout launch, row-drop override and permissions via CLI', () => {
  function initRepoWithWorktree() {
    const mainRepo = path.join(sandbox.root, 'main-repo');
    const worktree = path.join(sandbox.root, 'other-worktree');
    mkdirSync(mainRepo);
    assert.equal(spawnSync('git', ['init', '-q', mainRepo]).status, 0);
    writeFileSync(path.join(mainRepo, '.gitignore'), '/backups/\n');
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
        'init',
      ]).status,
      0
    );
    assert.equal(
      spawnSync('git', ['-C', mainRepo, 'worktree', 'add', '-q', worktree, '-b', 'wt']).status,
      0
    );
    return { mainRepo, worktree };
  }

  it('succeeds from another checkout into main repo gitignored backups/, prunes 10 to 2, and keeps git status clean', async () => {
    const { mainRepo, worktree } = initRepoWithWorktree();
    const targetBackups = path.join(mainRepo, 'backups');
    seedBackups(targetBackups, 10, { encrypted: false });

    const env = envFor(sandbox, db, { BACKUP_DIR: targetBackups });
    delete env.BACKUP_ENCRYPT;
    delete env.BACKUP_AGE_RECIPIENT_FILE;

    const result = await runCli(env, [], { cwd: worktree });
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

  it('refuses non-ignored path in destination repo with status reason and creates nothing', async () => {
    const { mainRepo, worktree } = initRepoWithWorktree();
    const unignored = path.join(mainRepo, 'unignored-backups');
    const env = envFor(sandbox, db, { BACKUP_DIR: unignored });

    const result = await runCli(env, [], { cwd: worktree });
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stdout, /не игнорируется git/);
    assert.match(
      readStatus(sandbox),
      /\tfailed\tсбой: каталог резервных копий не игнорируется git\n$/
    );
    assert.equal(existsSync(unignored), false, 'non-ignored dir was not created');
    assert.equal(readDockerCalls(), 0, 'docker was never called');
    const mainStatus = spawnSync('git', ['-C', mainRepo, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(mainStatus.stdout, '', 'destination repo remains clean');
  });

  it('refuses when git is unavailable with status reason and creates no copy', async () => {
    const { mainRepo } = initRepoWithWorktree();
    const targetBackups = path.join(mainRepo, 'backups');
    const env = envFor(sandbox, db, {
      BACKUP_DIR: targetBackups,
      BACKUP_GIT_BIN: '/nonexistent/git-binary',
    });
    const result = await runCli(env);
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
    });
    const env = envFor(sandbox, db, { FAKE_COUNTS: '{"a":10,"b":100}' });

    const rejected = await runCli(env);
    assert.equal(rejected.code, EXIT.suspicious);
    assert.match(rejected.stdout, /число строк упало более чем на 20%/);
    assert.match(readStatus(sandbox), /\tfailed\tсбой: число строк упало более чем на 20%\n$/);
    assert.deepEqual(listCopies(sandbox.backupDir).sort(), [...old].sort());

    const confirmed = await runCli(env, ['--allow-row-drop']);
    assert.equal(confirmed.code, EXIT.ok, confirmed.stderr + confirmed.stdout);
    const afterConfirm = listCopies(sandbox.backupDir);
    assert.equal(afterConfirm.length, 2);
    assert.ok(afterConfirm.includes(old[0]), 'newest prior copy kept');

    // Wait 1 second so the next CLI invocation gets a distinct timestamp.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const followUp = await runCli(env);
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
      `process.umask(0o000);\nconst { main } = await import(${JSON.stringify(CLI)});\nprocess.exitCode = await main(process.env, []);\n`
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
