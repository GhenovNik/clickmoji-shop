// Shared helpers for the backup tests. Every credential is generated at runtime and every
// file lives in a sandbox under the OS temp directory, outside the repository.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_NAME_PATTERN, LEDGER_NAME, PROJECT_NAME } from '../constants.mjs';
import { loadConfig } from '../config.mjs';
import { LAUNCH_BUSY, LAUNCH_FAILED, launchLocked } from '../lock.mjs';
import { reportBusy } from '../pipeline.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKUP_SRC = path.resolve(HERE, '..');
export const CLI = path.join(BACKUP_SRC, 'cli.mjs');
export const FAKE_DOCKER = path.join(HERE, 'fake-docker.mjs');
export const LOCK_WORKER = path.join(HERE, 'lock-worker.mjs');
export const RUN_LOCKED = path.join(HERE, 'run-locked.mjs');
chmodSync(FAKE_DOCKER, 0o755);

// Fixed clock for the tests: the new copy is named clickmoji-20261124T120000Z.dump.age.
export const NOW = new Date('2026-11-24T12:00:00.000Z');
export const NEW_NAME = 'clickmoji-20261124T120000Z.dump.age';

const AGE_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function randomRecipient() {
  let text = 'age1';
  for (const byte of crypto.randomBytes(58)) text += AGE_ALPHABET[byte % 32];
  return text;
}

// Initializes an isolated synthetic project repository in a temp directory so tests exercise the
// real git/project-identity guards without ever touching the real clickmoji-shop checkout or backups.
export function makeProjectRepo(
  repoDir,
  { gitignore = '/backups/\n', projectName = PROJECT_NAME, copyScripts = true } = {}
) {
  mkdirSync(repoDir, { recursive: true });
  if (spawnSync('git', ['init', '-q', repoDir]).status !== 0) {
    throw new Error('git init failed in test sandbox');
  }
  writeFileSync(path.join(repoDir, '.gitignore'), gitignore);
  const toAdd = ['.gitignore'];
  if (projectName !== null) {
    writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: projectName }) + '\n');
    toAdd.push('package.json');
  }
  if (copyScripts) {
    const destScripts = path.join(repoDir, 'scripts', 'backup');
    cpSync(BACKUP_SRC, destScripts, {
      recursive: true,
      filter: (src) => path.basename(src) !== 'test',
    });
    toAdd.push('scripts/backup');
  }
  if (spawnSync('git', ['-C', repoDir, 'add', ...toAdd]).status !== 0) {
    throw new Error('git add failed in test sandbox');
  }
  if (
    spawnSync('git', [
      '-C',
      repoDir,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e.invalid',
      'commit',
      '-q',
      '-m',
      'init',
    ]).status !== 0
  ) {
    throw new Error('git commit failed in test sandbox');
  }
  return {
    repo: repoDir,
    backupDir: path.join(repoDir, 'backups'),
    cli: path.join(repoDir, 'scripts', 'backup', 'cli.mjs'),
  };
}

export function makeSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-backup-test-'));
  const tmp = path.join(root, 'tmp');
  mkdirSync(tmp);
  const repoInfo = makeProjectRepo(path.join(root, 'repo'));
  const recipientFile = path.join(root, 'recipient.txt');
  writeFileSync(recipientFile, `# test recipient\n${randomRecipient()}\n`);
  return {
    root,
    tmp,
    repo: repoInfo.repo,
    cli: repoInfo.cli,
    backupDir: repoInfo.backupDir,
    statusFile: path.join(root, 'status.log'),
    logFile: path.join(root, 'docker.log'),
    dockerState: path.join(root, 'docker-state'),
    daemonLog: path.join(root, 'daemon.log'),
    recipientFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function fixtureUrl(address, username, password) {
  const url = new URL(address);
  url.username = username;
  url.password = password;
  return url.href;
}

// A database address that exists only in memory: the host is reserved (.invalid) and the
// password is random on every call.
export function syntheticDatabase() {
  const password = crypto.randomBytes(12).toString('hex');
  const host = 'synthetic-db.test.invalid';
  return {
    url: fixtureUrl(
      `postgresql://${host}:5432/clickmoji?sslmode=require&schema=public`,
      'app_user',
      password
    ),
    password,
    host,
  };
}

export function envFor(sandbox, db, extra = {}) {
  return {
    PATH: process.env.PATH,
    TMPDIR: sandbox.tmp,
    DATABASE_URL: db.url,
    BACKUP_DIR: sandbox.backupDir,
    BACKUP_STATUS_FILE: sandbox.statusFile,
    BACKUP_ENCRYPT: '1',
    BACKUP_AGE_RECIPIENT_FILE: sandbox.recipientFile,
    BACKUP_DOCKER_BIN: FAKE_DOCKER,
    FAKE_DOCKER_LOG: sandbox.logFile,
    FAKE_DOCKER_STATE: sandbox.dockerState,
    FAKE_DAEMON_LOG: sandbox.daemonLog,
    FAKE_WATCH_LOCK: path.join(sandbox.backupDir, '.backup.lock'),
    FAKE_WATCH_LEDGER: path.join(sandbox.backupDir, LEDGER_NAME),
    ...extra,
  };
}

// Containers the fake daemon still knows about (killed clients leave theirs behind).
export function containersLeft(sandbox) {
  const dir = path.join(sandbox.dockerState, 'containers');
  return existsSync(dir) ? readdirSync(dir) : [];
}

// Removals the fake daemon performed, in order.
export function removalEvents(sandbox) {
  const file = path.join(sandbox.dockerState, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function daemonLog(sandbox) {
  return existsSync(sandbox.daemonLog) ? readFileSync(sandbox.daemonLog, 'utf8') : '';
}

// One backup run with the fake docker, as the lock holder in a child process (the way cli.mjs runs
// it). `child` is the writer; `done` resolves to the run's result. A run that finds the lock held
// reports busy, exactly as cli.mjs does.
export function startLockedRun({
  mode = 'backup',
  backupDir,
  env,
  now = NOW,
  tempRoot,
  allowRowDrop = false,
  confirmFile = null,
  projectRoot,
}) {
  const child = launchLocked(backupDir, [process.execPath, RUN_LOCKED], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {}); // a launcher that never ran has no stdin reader
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', () => {});
  child.stdin.end(
    JSON.stringify({
      mode,
      env,
      now: now.toISOString(),
      tempRoot,
      allowRowDrop,
      confirmFile,
      projectRoot,
    })
  );
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === LAUNCH_BUSY || code === LAUNCH_FAILED) {
        resolve(reportBusy(loadConfig(env), () => now));
        return;
      }
      // A writer killed before it printed its result has no line: that is null, not an error.
      const line = stdout.trim().split('\n').pop();
      resolve(line ? JSON.parse(line) : null);
    });
  });
  return { child, done };
}

// Runs one fake-docker backup as the lock holder and returns its result.
export function runWithFake(
  sandbox,
  db,
  extra = {},
  now = NOW,
  { allowRowDrop = false, projectRoot = sandbox.repo } = {}
) {
  const env = envFor(sandbox, db, extra);
  return startLockedRun({
    backupDir: env.BACKUP_DIR,
    env,
    now,
    tempRoot: sandbox.tmp,
    allowRowDrop,
    projectRoot,
  }).done;
}

export function runConfirmWithFake(
  sandbox,
  confirmFile,
  extra = {},
  now = NOW,
  { projectRoot = sandbox.repo } = {}
) {
  const env = {
    PATH: process.env.PATH,
    BACKUP_DIR: sandbox.backupDir,
    BACKUP_STATUS_FILE: sandbox.statusFile,
    ...extra,
  };
  return startLockedRun({
    mode: 'confirm',
    backupDir: env.BACKUP_DIR,
    env,
    now,
    confirmFile,
    projectRoot,
  }).done;
}

// Spawns the real CLI and captures what it prints.
export function runCli(env, args = [], { cwd = undefined, cli = CLI } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      cwd,
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
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

// Old copies, going back from NOW, with committed acceptance metadata.
// When `legacy` is true, writes the prior-version metadata shape (without `encrypted`).
export function seedBackups(
  backupDir,
  count,
  { counts = null, encrypted = true, startDay = 1, legacy = false } = {}
) {
  mkdirSync(path.join(backupDir, 'meta'), { recursive: true, mode: 0o700 });
  const names = [];
  const suffix = encrypted ? '.dump.age' : '.dump';
  for (let i = 0; i < count; i += 1) {
    const day = startDay + i;
    const when = new Date(NOW.getTime() - day * 86_400_000);
    const iso = when
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    const name = `clickmoji-${iso}${suffix}`;
    const body = `old ${day}`;
    writeFileSync(path.join(backupDir, name), body, { mode: 0o600 });
    names.push(name);
    const rowCounts = i === 0 && counts ? counts : {};
    const sizeBytes = Buffer.byteLength(body);
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const meta = legacy
      ? {
          name,
          createdAt: when.toISOString(),
          sizeBytes,
          sha256: hash,
          verify: 'ok',
          migration: '20261101000000_init',
          counts: rowCounts,
          flagged: [],
        }
      : {
          name,
          encrypted,
          sizeBytes,
          sha256: hash,
          verify: 'ok',
          counts: rowCounts,
        };
    writeFileSync(path.join(backupDir, 'meta', `${name}.json`), JSON.stringify(meta), {
      mode: 0o600,
    });
  }
  return names;
}

export function listCopies(backupDir) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => BACKUP_NAME_PATTERN.test(name))
    .sort();
}

export function readStatus(sandbox) {
  return existsSync(sandbox.statusFile) ? readFileSync(sandbox.statusFile, 'utf8') : '';
}

export function readDockerLog(sandbox) {
  if (!existsSync(sandbox.logFile)) return [];
  return readFileSync(sandbox.logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export const LOCK = (backupDir) => path.join(backupDir, '.backup.lock');

// A writer process that holds the real backup lock until `gate` exists (or until it is killed).
// `report` resolves to its first JSON line (null when it never ran); `acquired` is true when it
// holds the lock; `exited` resolves when it has gone. `mode` is a lock-worker.mjs mode.
export function spawnLockHolder(backupDir, gate, mode = 'hold') {
  const child = launchLocked(backupDir, [process.execPath, LOCK_WORKER, backupDir, gate, mode], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buffer = '';
  const report = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at !== -1) resolve(JSON.parse(buffer.slice(0, at)));
    });
    child.on('close', () => resolve(null));
  });
  const acquired = report.then((line) => line?.acquired === true);
  const exited = new Promise((resolve) => child.on('close', resolve));
  return { child, report, acquired, exited };
}

// True when no live process holds the backup lock. Probes by starting a writer that does nothing
// and exits, which needs the lock: a launcher refused as busy means it is held.
export function lockIsFree(backupDir) {
  return new Promise((resolve) => {
    const probe = launchLocked(backupDir, [process.execPath, '-e', ''], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

// True while some other open file description holds an exclusive flock on the lock file. Used
// from child processes (the fake docker) that cannot take the Node lock object.
export function lockHeldSync(backupDir) {
  const probe = `open my $f, "<", $ARGV[0] or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 3);`;
  const result = spawnSync('/usr/bin/perl', ['-MFcntl=:flock', '-e', probe, LOCK(backupDir)]);
  return result.status === 3;
}
