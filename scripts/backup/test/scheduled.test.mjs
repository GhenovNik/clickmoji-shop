// Scheduled copy wrapper and launchd installer (AGE-1669, task Г). Fake security, npm and launchctl
// only: no Keychain, no database, no LaunchAgent is touched. HOME is a sandbox, so the paths the
// scripts derive from it stay inside the sandbox. The database address below is generated per run.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = realpathSync(path.resolve(HERE, '..', '..', '..'));
const WRAPPER = path.join(REPO_ROOT, 'scripts', 'backup', 'run-scheduled.sh');
const INSTALL = path.join(REPO_ROOT, 'scripts', 'backup', 'launchd', 'install.sh');
const UNINSTALL = path.join(REPO_ROOT, 'scripts', 'backup', 'launchd', 'uninstall.sh');
const LABEL = 'com.clickmoji.db-backup';
const FAILED_TEXT = 'сбой: нет роли только на чтение в связке ключей';
const STATUS_LINE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\tfailed\tсбой: нет роли только на чтение в связке ключей\n$/;

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const FAKE_SECURITY = `#!/bin/sh
# Fake macOS security: records its argv, then prints and exits as the test asks.
printf '%s\\n' "$*" > "$FAKE_RECORD_DIR/security-argv"
if [ -n "\${FAKE_SECURITY_STDERR:-}" ]; then printf '%s\\n' "$FAKE_SECURITY_STDERR" >&2; fi
if [ -n "\${FAKE_SECURITY_OUTPUT:-}" ]; then printf '%s\\n' "$FAKE_SECURITY_OUTPUT"; fi
exit "\${FAKE_SECURITY_EXIT:-0}"
`;

// Fake npm: records only booleans and the fixed settings it was given, never the address itself.
const FAKE_NPM = `#!/bin/sh
d="$FAKE_RECORD_DIR"
printf '%s\\n' "$*" > "$d/npm-argv"
if [ "\${DATABASE_URL:-}" = "$FAKE_EXPECTED_URL" ]; then echo match > "$d/npm-url"; else echo mismatch > "$d/npm-url"; fi
printf 'BACKUP_DIR=%s\\nTMPDIR=%s\\nBACKUP_STATUS_FILE=%s\\nBACKUP_ENCRYPT=%s\\nBACKUP_RETENTION_COUNT=%s\\n' \\
  "$BACKUP_DIR" "$TMPDIR" "$BACKUP_STATUS_FILE" "$BACKUP_ENCRYPT" "$BACKUP_RETENTION_COUNT" > "$d/npm-env"
echo "backup: ok verify=ok size=1 file=x prune=ok"
exit "\${FAKE_NPM_EXIT:-0}"
`;

// Fake launchctl: the loaded state is a marker file; every call is logged with its arguments.
const FAKE_LAUNCHCTL = `#!/bin/sh
state="$FAKE_RECORD_DIR/loaded"
printf '%s\\n' "$*" >> "$FAKE_RECORD_DIR/launchctl.log"
case "$1" in
  print) if [ -f "$state" ]; then exit 0; fi; exit 113 ;;
  bootout)
    if [ -n "\${FAKE_BOOTOUT_FAIL:-}" ]; then exit 5; fi
    if [ ! -f "$state" ]; then exit 113; fi
    rm -f "$state"; exit 0 ;;
  bootstrap)
    if [ -f "$state" ]; then exit 37; fi
    if [ ! -f "$3" ]; then exit 2; fi
    touch "$state"; exit 0 ;;
  *) exit 1 ;;
esac
`;

function makeSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-sched-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const record = path.join(root, 'record');
  mkdirSync(path.join(home, 'Projects'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(record);
  for (const [name, body] of [
    ['security', FAKE_SECURITY],
    ['npm', FAKE_NPM],
    ['launchctl', FAKE_LAUNCHCTL],
  ]) {
    const file = path.join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  return { root, home, bin, record };
}

// A fake main checkout: the sandbox's ~/Projects/clickmoji-shop points at the real repository.
function linkMainCheckout(sandbox) {
  symlinkSync(REPO_ROOT, path.join(sandbox.home, 'Projects', 'clickmoji-shop'));
}

function randomSecretUrl() {
  const password = crypto.randomBytes(24).toString('hex');
  return `postgres://clickmoji_backup_ro:${password}@ep-test-${crypto.randomBytes(4).toString('hex')}.example.invalid/clickmoji?sslmode=require`;
}

function baseEnv(sandbox, extra = {}) {
  return {
    HOME: sandbox.home,
    PATH: `${sandbox.bin}:${process.env.PATH}`,
    LANG: 'C',
    FAKE_RECORD_DIR: sandbox.record,
    ...extra,
  };
}

function run(file, args, env, cwd = REPO_ROOT) {
  return spawnSync('/bin/bash', [file, ...args], { env, cwd, encoding: 'utf8' });
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

// Every regular file under dir (symlinks are not followed).
function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function assertNoSecretOnDisk(sandbox, secret) {
  for (const file of filesUnder(sandbox.root)) {
    assert.equal(readText(file).includes(secret), false, `secret found in ${path.basename(file)}`);
  }
}

describe('run-scheduled.sh', () => {
  it('passes the Keychain address only in npm environment and writes no secret anywhere', () => {
    const sandbox = makeSandbox();
    const secret = randomSecretUrl();
    const env = baseEnv(sandbox, {
      FAKE_SECURITY_OUTPUT: secret,
      FAKE_EXPECTED_URL: secret,
    });
    const result = run(WRAPPER, [], env);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readText(path.join(sandbox.record, 'security-argv')).trim(),
      'find-generic-password -s clickmoji-backup-readonly -w');
    assert.equal(readText(path.join(sandbox.record, 'npm-argv')).trim(), 'run db:backup:verified');
    assert.equal(readText(path.join(sandbox.record, 'npm-url')).trim(), 'match');
    assert.match(result.stdout, /backup: ok/);

    const npmEnv = readText(path.join(sandbox.record, 'npm-env'));
    const mainBackups = path.join(sandbox.home, 'Projects', 'clickmoji-shop', 'backups');
    assert.ok(npmEnv.includes(`BACKUP_DIR=${mainBackups}\n`), npmEnv);
    assert.ok(
      npmEnv.includes(`TMPDIR=${path.join(sandbox.home, 'Library', 'Caches', 'clickmoji-backup', 'tmp')}\n`),
      npmEnv,
    );
    assert.ok(
      npmEnv.includes(`BACKUP_STATUS_FILE=${path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'status.tsv')}\n`),
      npmEnv,
    );
    assert.ok(npmEnv.includes('BACKUP_ENCRYPT=0\n'), npmEnv);
    assert.ok(npmEnv.includes('BACKUP_RETENTION_COUNT=2\n'), npmEnv);

    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assertNoSecretOnDisk(sandbox, secret);
  });

  it('records a failed Keychain lookup in the status format and never runs npm', () => {
    const sandbox = makeSandbox();
    const diagnostic = 'security: SecKeychainSearchCopyNext: The specified item could not be found.';
    const env = baseEnv(sandbox, {
      FAKE_SECURITY_EXIT: '44',
      FAKE_SECURITY_STDERR: diagnostic,
      FAKE_EXPECTED_URL: randomSecretUrl(),
    });
    const result = run(WRAPPER, [], env);

    assert.equal(result.status, 1);
    assert.equal(existsSync(path.join(sandbox.record, 'npm-argv')), false, 'npm must not run');
    assert.ok(result.stdout.includes(FAILED_TEXT), result.stdout);
    assert.equal(result.stdout.includes('could not be found'), false);
    assert.equal(result.stderr.includes('could not be found'), false);

    const statusFile = path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'status.tsv');
    const status = readText(statusFile);
    assert.match(status, STATUS_LINE);
    assert.equal(status.includes('could not be found'), false);
    assert.equal(status.split('\t').length, 3);
  });

  it('treats an empty Keychain value as a missing role and writes the same status line', () => {
    // An empty value with exit 0 is the same failure as a lookup that found nothing.
    const sandbox = makeSandbox();
    const env = baseEnv(sandbox, { FAKE_SECURITY_EXIT: '0', FAKE_SECURITY_OUTPUT: '' });
    const result = run(WRAPPER, [], env);

    assert.equal(result.status, 1);
    assert.equal(existsSync(path.join(sandbox.record, 'npm-argv')), false, 'npm must not run');
    const status = readText(path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'status.tsv'));
    assert.match(status, STATUS_LINE);
  });

  it('keeps the exit code of a failed copy and leaves the status file to the copy itself', () => {
    const sandbox = makeSandbox();
    const secret = randomSecretUrl();
    const env = baseEnv(sandbox, {
      FAKE_SECURITY_OUTPUT: secret,
      FAKE_EXPECTED_URL: secret,
      FAKE_NPM_EXIT: '3',
    });
    const result = run(WRAPPER, [], env);

    assert.equal(result.status, 3);
    assert.equal(existsSync(path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'status.tsv')), false);
  });

  it('does not append through a status file that is a symlink, and reports it', () => {
    const sandbox = makeSandbox();
    const logDir = path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup');
    mkdirSync(logDir, { recursive: true });
    const elsewhere = path.join(sandbox.root, 'elsewhere.txt');
    writeFileSync(elsewhere, 'unchanged\n');
    symlinkSync(elsewhere, path.join(logDir, 'status.tsv'));

    const result = run(WRAPPER, [], baseEnv(sandbox, { FAKE_SECURITY_EXIT: '44' }));

    assert.equal(result.status, 1);
    assert.equal(readText(elsewhere), 'unchanged\n');
    assert.ok(lstatSync(path.join(logDir, 'status.tsv')).isSymbolicLink());
    assert.ok(result.stderr.includes('BACKUP_STATUS_FILE: символическая ссылка'), result.stderr);
  });
});

describe('launchd installer and remover', () => {
  it('installs the agent with the default interval and no run at load', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    const result = run(INSTALL, [], baseEnv(sandbox));

    assert.equal(result.status, 0, result.stderr);
    const plist = readText(path.join(sandbox.home, 'Library', 'LaunchAgents', `${LABEL}.plist`));
    assert.match(plist, new RegExp(`<key>StartInterval</key>\\s*<integer>259200</integer>`));
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
    assert.ok(plist.includes(`<string>${WRAPPER}</string>`));
    assert.ok(plist.includes(`<string>${REPO_ROOT}</string>`));
    assert.equal(/__[A-Z_]+__/.test(plist), false, 'every placeholder is replaced');
    assert.ok(plist.includes(`<string>${path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'launchd.log')}</string>`));
    assert.match(readText(path.join(sandbox.record, 'launchctl.log')), /^bootstrap gui\/\d+ .*\.plist$/m);
    assert.ok(existsSync(path.join(sandbox.record, 'loaded')));
  });

  it('replaces a loaded agent with bootout before bootstrap, and takes a configured interval', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);

    const second = run(INSTALL, [], baseEnv(sandbox, { CLICKMOJI_BACKUP_INTERVAL_SECONDS: '3600' }));
    assert.equal(second.status, 0, second.stderr);

    const calls = readText(path.join(sandbox.record, 'launchctl.log')).trim().split('\n');
    const bootoutAt = calls.findIndex((line) => line.startsWith('bootout'));
    const bootstrapAt = calls.findLastIndex((line) => line.startsWith('bootstrap'));
    assert.equal(calls.filter((line) => line.startsWith('bootout')).length, 1);
    assert.equal(calls.filter((line) => line.startsWith('bootstrap')).length, 2);
    assert.ok(bootoutAt >= 0 && bootoutAt < bootstrapAt, 'bootout comes before the second bootstrap');
    const plist = readText(path.join(sandbox.home, 'Library', 'LaunchAgents', `${LABEL}.plist`));
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
    assert.ok(existsSync(path.join(sandbox.record, 'loaded')));
  });

  it('refuses an invalid interval before writing anything', () => {
    for (const bad of ['abc', '30', '1.5', '-5']) {
      const sandbox = makeSandbox();
      linkMainCheckout(sandbox);
      const env = baseEnv(sandbox, { CLICKMOJI_BACKUP_INTERVAL_SECONDS: bad });
      const result = run(INSTALL, [], env);
      assert.notEqual(result.status, 0, `interval ${JSON.stringify(bad)}`);
      assert.equal(existsSync(path.join(sandbox.home, 'Library', 'LaunchAgents')), false);
    }
  });

  it('refuses to install from anywhere but the main checkout', () => {
    const sandbox = makeSandbox();
    mkdirSync(path.join(sandbox.home, 'Projects', 'clickmoji-shop'));
    const result = run(INSTALL, [], baseEnv(sandbox));

    assert.equal(result.status, 1);
    assert.equal(existsSync(path.join(sandbox.home, 'Library', 'LaunchAgents', `${LABEL}.plist`)), false);
    assert.equal(existsSync(path.join(sandbox.record, 'launchctl.log')), false);
  });

  it('keeps the old agent and does not bootstrap when bootout fails', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);

    const result = run(INSTALL, [], baseEnv(sandbox, { FAKE_BOOTOUT_FAIL: '1' }));
    assert.equal(result.status, 1);
    const bootstraps = readText(path.join(sandbox.record, 'launchctl.log')).split('\n').filter((l) => l.startsWith('bootstrap'));
    assert.equal(bootstraps.length, 1, 'no second bootstrap');
  });

  it('removes the agent, is idempotent, and keeps the status file and copies', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);
    const logDir = path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup');
    writeFileSync(path.join(logDir, 'status.tsv'), 'kept\n');

    const first = run(UNINSTALL, [], baseEnv(sandbox));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(path.join(sandbox.home, 'Library', 'LaunchAgents', `${LABEL}.plist`)), false);
    assert.equal(existsSync(path.join(sandbox.record, 'loaded')), false);

    const second = run(UNINSTALL, [], baseEnv(sandbox));
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readText(path.join(logDir, 'status.tsv')), 'kept\n');
  });
});
