// Scheduled copy wrapper and launchd installer (AGE-1669). Fake security, npm and launchctl
// only: no Keychain, no database, no LaunchAgent is touched. HOME is a sandbox, so the paths the
// scripts derive from it stay inside the sandbox. The database addresses below are generated per run
// and point only at localhost.
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
const SERVICE = 'clickmoji-backup-readonly';
const ACCOUNT = 'clickmoji';
const FAILED_TEXT = 'сбой: нет роли только на чтение в связке ключей';
const STATUS_LINE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\tfailed\tсбой: нет роли только на чтение в связке ключей\n$/;
const RECOVERY_FAILED = 'ВОССТАНОВЛЕНИЕ НЕ УДАЛОСЬ';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// Fake macOS security, written in Node so it can match records exactly. It logs its argv, then looks
// up the fixture table in FAKE_KEYCHAIN_FILE. A row is: keychain path, service, account, secret, joined
// by tabs. A lookup must match service and account exactly; when a keychain path is given it must also
// match that keychain. Without a keychain path any keychain matches, as the search list would. The
// first matching row is printed, and a miss exits 44 with a diagnostic that the wrapper must not show.
const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.env.FAKE_RECORD_DIR, 'security-argv'), args.join(' ') + '\\n');
let service = '';
let account = '';
let keychain = '';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '-s') {
    i += 1;
    service = args[i];
  } else if (args[i] === '-a') {
    i += 1;
    account = args[i];
  } else if (args[i] !== 'find-generic-password' && args[i] !== '-w' && !args[i].startsWith('-')) {
    keychain = args[i];
  }
}
const rows = fs
  .readFileSync(process.env.FAKE_KEYCHAIN_FILE, 'utf8')
  .split('\\n')
  .filter((line) => line !== '')
  .map((line) => line.split('\\t'));
const hit = rows.find(
  ([kc, svc, acct]) => svc === service && acct === account && (keychain === '' || kc === keychain)
);
if (!hit) {
  process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found.\\n');
  process.exit(44);
}
process.stdout.write(hit[3] + '\\n');
process.exit(0);
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

// Fake launchctl: the loaded state is a copy of the plist that was bootstrapped, so a test can tell
// which definition is loaded; every call is logged with its arguments.
// FAKE_BOOTSTRAP_FAIL_ALL makes every bootstrap fail; FAKE_BOOTSTRAP_FAIL_WHEN makes a bootstrap fail
// only when the plist it loads contains that fixed text.
// Signal windows: with FAKE_SIGNAL_SIG set, the fake sends that signal to the installer (its parent)
// from inside one call. FAKE_SIGNAL_VERB=bootout sends it after the job is unloaded;
// FAKE_SIGNAL_VERB=bootstrap sends it during a bootstrap whose plist contains FAKE_SIGNAL_WHEN, and
// FAKE_SIGNAL_RESULT=fail makes that bootstrap fail after the signal (the default is to load and return 0).
// The shell runs its trap only after the call returns, as it does for a real signal.
const FAKE_LAUNCHCTL = `#!/bin/sh
state="$FAKE_RECORD_DIR/loaded"
printf '%s\\n' "$*" >> "$FAKE_RECORD_DIR/launchctl.log"
case "$1" in
  print) if [ -f "$state" ]; then exit 0; fi; exit 113 ;;
  bootout)
    if [ -n "\${FAKE_BOOTOUT_FAIL:-}" ]; then exit 5; fi
    if [ ! -f "$state" ]; then exit 113; fi
    rm -f "$state"
    if [ "\${FAKE_SIGNAL_VERB:-}" = bootout ]; then kill -"$FAKE_SIGNAL_SIG" "$PPID"; fi
    exit 0 ;;
  bootstrap)
    if [ -n "\${FAKE_BOOTSTRAP_FAIL_ALL:-}" ]; then exit 5; fi
    if [ -n "\${FAKE_BOOTSTRAP_FAIL_WHEN:-}" ] && grep -q -F -- "$FAKE_BOOTSTRAP_FAIL_WHEN" "$3"; then exit 5; fi
    if [ -f "$state" ]; then exit 37; fi
    if [ ! -f "$3" ]; then exit 2; fi
    if [ "\${FAKE_SIGNAL_VERB:-}" = bootstrap ] && grep -q -F -- "$FAKE_SIGNAL_WHEN" "$3"; then
      kill -"$FAKE_SIGNAL_SIG" "$PPID"
      if [ "\${FAKE_SIGNAL_RESULT:-ok}" = fail ]; then exit 5; fi
    fi
    cp -- "$3" "$state"; exit 0 ;;
  *) exit 1 ;;
esac
`;

function makeSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-sched-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const record = path.join(root, 'record');
  const keychainFile = path.join(root, 'keychain.tsv');
  mkdirSync(path.join(home, 'Projects'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(record);
  writeFileSync(keychainFile, '');
  for (const [name, body] of [
    ['security', FAKE_SECURITY],
    ['npm', FAKE_NPM],
    ['launchctl', FAKE_LAUNCHCTL],
  ]) {
    const file = path.join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  return { root, home, bin, record, keychainFile };
}

// The login keychain path the wrapper must name, and a second keychain that holds decoy records.
function loginKeychain(sandbox) {
  return path.join(sandbox.home, 'Library', 'Keychains', 'login.keychain-db');
}

function otherKeychain(sandbox) {
  return path.join(sandbox.home, 'Library', 'Keychains', 'old-login.keychain-db');
}

// Replaces the fixture table. Each row is { keychain, service, account, secret }.
function setKeychainRows(sandbox, rows) {
  const text = rows
    .map((row) => [row.keychain, row.service, row.account, row.secret].join('\t') + '\n')
    .join('');
  writeFileSync(sandbox.keychainFile, text);
}

// A fake main checkout: the sandbox's ~/Projects/clickmoji-shop points at the real repository.
function linkMainCheckout(sandbox) {
  symlinkSync(REPO_ROOT, path.join(sandbox.home, 'Projects', 'clickmoji-shop'));
}

function randomSecretUrl() {
  const password = crypto.randomBytes(24).toString('hex');
  return `postgres://clickmoji_backup_ro:${password}@localhost/clickmoji?sslmode=require`;
}

function baseEnv(sandbox, extra = {}) {
  return {
    HOME: sandbox.home,
    PATH: `${sandbox.bin}:${process.env.PATH}`,
    LANG: 'C',
    FAKE_RECORD_DIR: sandbox.record,
    FAKE_KEYCHAIN_FILE: sandbox.keychainFile,
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

// The fixture table holds the test's own addresses by design, so it is the one file skipped here.
function assertNoSecretOnDisk(sandbox, secret) {
  for (const file of filesUnder(sandbox.root)) {
    if (file === sandbox.keychainFile) continue;
    assert.equal(readText(file).includes(secret), false, `secret found in ${path.basename(file)}`);
  }
}

describe('run-scheduled.sh', () => {
  it('reads only the intended record and passes it only in npm environment', () => {
    const sandbox = makeSandbox();
    const intended = randomSecretUrl();
    // Two decoys share the service. One is in another keychain and comes first in the table, so a
    // lookup without an explicit keychain would return it. The other is in the login keychain under
    // a different account.
    setKeychainRows(sandbox, [
      {
        keychain: otherKeychain(sandbox),
        service: SERVICE,
        account: ACCOUNT,
        secret: randomSecretUrl(),
      },
      { keychain: loginKeychain(sandbox), service: SERVICE, account: ACCOUNT, secret: intended },
      {
        keychain: loginKeychain(sandbox),
        service: SERVICE,
        account: 'clickmoji-admin',
        secret: randomSecretUrl(),
      },
    ]);
    const env = baseEnv(sandbox, { FAKE_EXPECTED_URL: intended });
    const result = run(WRAPPER, [], env);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readText(path.join(sandbox.record, 'security-argv')).trim(),
      `find-generic-password -s ${SERVICE} -a ${ACCOUNT} -w ${loginKeychain(sandbox)}`
    );
    assert.equal(readText(path.join(sandbox.record, 'npm-argv')).trim(), 'run db:backup:verified');
    assert.equal(readText(path.join(sandbox.record, 'npm-url')).trim(), 'match');
    assert.match(result.stdout, /backup: ok/);

    const npmEnv = readText(path.join(sandbox.record, 'npm-env'));
    const mainBackups = path.join(sandbox.home, 'Projects', 'clickmoji-shop', 'backups');
    assert.ok(npmEnv.includes(`BACKUP_DIR=${mainBackups}\n`), npmEnv);
    assert.ok(
      npmEnv.includes(
        `TMPDIR=${path.join(sandbox.home, 'Library', 'Caches', 'clickmoji-backup', 'tmp')}\n`
      ),
      npmEnv
    );
    assert.ok(
      npmEnv.includes(
        `BACKUP_STATUS_FILE=${path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'status.tsv')}\n`
      ),
      npmEnv
    );
    assert.ok(npmEnv.includes('BACKUP_ENCRYPT=0\n'), npmEnv);
    assert.ok(npmEnv.includes('BACKUP_RETENTION_COUNT=2\n'), npmEnv);

    assert.equal(result.stdout.includes(intended), false);
    assert.equal(result.stderr.includes(intended), false);
    assertNoSecretOnDisk(sandbox, intended);
  });

  it('does not run npm when only wrong-keychain or wrong-account records exist', () => {
    const sandbox = makeSandbox();
    // Neither decoy is the intended record: one is in another keychain, one in the login keychain
    // under another account. Nothing should be used, so npm must not run.
    setKeychainRows(sandbox, [
      {
        keychain: otherKeychain(sandbox),
        service: SERVICE,
        account: ACCOUNT,
        secret: randomSecretUrl(),
      },
      {
        keychain: loginKeychain(sandbox),
        service: SERVICE,
        account: 'clickmoji-admin',
        secret: randomSecretUrl(),
      },
    ]);
    const result = run(WRAPPER, [], baseEnv(sandbox, { FAKE_EXPECTED_URL: randomSecretUrl() }));

    assert.equal(result.status, 1);
    assert.equal(existsSync(path.join(sandbox.record, 'npm-argv')), false, 'npm must not run');
    assert.ok(result.stdout.includes(FAILED_TEXT), result.stdout);
    assert.match(
      readText(path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'status.tsv')),
      STATUS_LINE
    );
  });

  it('records a failed Keychain lookup in the status format and never runs npm', () => {
    const sandbox = makeSandbox();
    const result = run(WRAPPER, [], baseEnv(sandbox, { FAKE_EXPECTED_URL: randomSecretUrl() }));

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
    setKeychainRows(sandbox, [
      { keychain: loginKeychain(sandbox), service: SERVICE, account: ACCOUNT, secret: '' },
    ]);
    const result = run(WRAPPER, [], baseEnv(sandbox));

    assert.equal(result.status, 1);
    assert.equal(existsSync(path.join(sandbox.record, 'npm-argv')), false, 'npm must not run');
    const status = readText(
      path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'status.tsv')
    );
    assert.match(status, STATUS_LINE);
  });

  it('keeps the exit code of a failed copy and leaves the status file to the copy itself', () => {
    const sandbox = makeSandbox();
    const secret = randomSecretUrl();
    setKeychainRows(sandbox, [
      { keychain: loginKeychain(sandbox), service: SERVICE, account: ACCOUNT, secret },
    ]);
    const env = baseEnv(sandbox, { FAKE_EXPECTED_URL: secret, FAKE_NPM_EXIT: '3' });
    const result = run(WRAPPER, [], env);

    assert.equal(result.status, 3);
    assert.equal(
      existsSync(path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'status.tsv')),
      false
    );
  });

  it('does not append through a status file that is a symlink, and reports it', () => {
    const sandbox = makeSandbox();
    const logDir = path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup');
    mkdirSync(logDir, { recursive: true });
    const elsewhere = path.join(sandbox.root, 'elsewhere.txt');
    writeFileSync(elsewhere, 'unchanged\n');
    symlinkSync(elsewhere, path.join(logDir, 'status.tsv'));

    const result = run(WRAPPER, [], baseEnv(sandbox));

    assert.equal(result.status, 1);
    assert.equal(readText(elsewhere), 'unchanged\n');
    assert.ok(lstatSync(path.join(logDir, 'status.tsv')).isSymbolicLink());
    assert.ok(result.stderr.includes('BACKUP_STATUS_FILE: символическая ссылка'), result.stderr);
  });
});

describe('launchd installer and remover', () => {
  // Every file in the LaunchAgents directory, so a leftover temporary or backup copy shows up.
  function agentDirFiles(sandbox) {
    return readdirSync(path.join(sandbox.home, 'Library', 'LaunchAgents')).sort();
  }

  function plistPath(sandbox) {
    return path.join(sandbox.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  }

  function launchctlCalls(sandbox) {
    return readText(path.join(sandbox.record, 'launchctl.log')).trim().split('\n');
  }

  it('installs the agent with the default interval and no run at load', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    const result = run(INSTALL, [], baseEnv(sandbox));

    assert.equal(result.status, 0, result.stderr);
    const plist = readText(plistPath(sandbox));
    assert.match(plist, new RegExp(`<key>StartInterval</key>\\s*<integer>259200</integer>`));
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
    assert.ok(plist.includes(`<string>${WRAPPER}</string>`));
    assert.ok(plist.includes(`<string>${REPO_ROOT}</string>`));
    assert.equal(/__[A-Z_]+__/.test(plist), false, 'every placeholder is replaced');
    assert.ok(
      plist.includes(
        `<string>${path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup', 'launchd.log')}</string>`
      )
    );
    assert.match(
      readText(path.join(sandbox.record, 'launchctl.log')),
      /^bootstrap gui\/\d+ .*\.plist$/m
    );
    assert.ok(existsSync(path.join(sandbox.record, 'loaded')));
    assert.deepEqual(agentDirFiles(sandbox), [`${LABEL}.plist`]);
  });

  it('replaces a loaded agent with bootout before bootstrap, and takes a configured interval', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);

    const second = run(
      INSTALL,
      [],
      baseEnv(sandbox, { CLICKMOJI_BACKUP_INTERVAL_SECONDS: '3600' })
    );
    assert.equal(second.status, 0, second.stderr);

    const calls = launchctlCalls(sandbox);
    const bootoutAt = calls.findIndex((line) => line.startsWith('bootout'));
    const bootstrapAt = calls.findLastIndex((line) => line.startsWith('bootstrap'));
    assert.equal(calls.filter((line) => line.startsWith('bootout')).length, 1);
    assert.equal(calls.filter((line) => line.startsWith('bootstrap')).length, 2);
    assert.ok(
      bootoutAt >= 0 && bootoutAt < bootstrapAt,
      'bootout comes before the second bootstrap'
    );
    assert.match(
      readText(plistPath(sandbox)),
      /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/
    );
    assert.ok(existsSync(path.join(sandbox.record, 'loaded')));
    assert.deepEqual(agentDirFiles(sandbox), [`${LABEL}.plist`]);
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
    assert.equal(existsSync(plistPath(sandbox)), false);
    assert.equal(existsSync(path.join(sandbox.record, 'launchctl.log')), false);
  });

  it('keeps the old plist byte for byte and the loaded agent when bootout fails', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);
    const oldPlist = readFileSync(plistPath(sandbox));

    const result = run(
      INSTALL,
      [],
      baseEnv(sandbox, { CLICKMOJI_BACKUP_INTERVAL_SECONDS: '3600', FAKE_BOOTOUT_FAIL: '1' })
    );

    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes('прежний агент и plist не тронуты'), result.stderr);
    assert.deepEqual(readFileSync(plistPath(sandbox)), oldPlist, 'old plist unchanged');
    assert.ok(existsSync(path.join(sandbox.record, 'loaded')), 'old job still loaded');
    const bootstraps = launchctlCalls(sandbox).filter((l) => l.startsWith('bootstrap'));
    assert.equal(bootstraps.length, 1, 'no second bootstrap');
    assert.deepEqual(agentDirFiles(sandbox), [`${LABEL}.plist`], 'no temporary copies left');
  });

  it('restores the old plist and reloads the old job when bootstrap of the new one fails', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);
    const oldPlist = readFileSync(plistPath(sandbox));

    const result = run(
      INSTALL,
      [],
      baseEnv(sandbox, {
        CLICKMOJI_BACKUP_INTERVAL_SECONDS: '3600',
        FAKE_BOOTSTRAP_FAIL_WHEN: '<integer>3600</integer>',
      })
    );

    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes('прежний агент восстановлен'), result.stderr);
    assert.equal(result.stderr.includes(RECOVERY_FAILED), false);
    assert.deepEqual(
      readFileSync(plistPath(sandbox)),
      oldPlist,
      'old plist restored byte for byte'
    );
    assert.ok(existsSync(path.join(sandbox.record, 'loaded')), 'old job reloaded');
    // A launchctl print follows the restore; only the state-changing calls are compared.
    const changing = launchctlCalls(sandbox)
      .map((line) => line.split(' ')[0])
      .filter((verb) => verb === 'bootout' || verb === 'bootstrap');
    assert.deepEqual(
      changing.slice(-3),
      ['bootout', 'bootstrap', 'bootstrap'],
      'bootout, failed new bootstrap, then the restore'
    );
    assert.deepEqual(agentDirFiles(sandbox), [`${LABEL}.plist`], 'no temporary copies left');
  });

  it('leaves no agent and no plist when the first install fails to bootstrap', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);

    const result = run(INSTALL, [], baseEnv(sandbox, { FAKE_BOOTSTRAP_FAIL_ALL: '1' }));

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr.includes(RECOVERY_FAILED), false);
    assert.equal(existsSync(path.join(sandbox.record, 'loaded')), false, 'not loaded');
    assert.equal(existsSync(plistPath(sandbox)), false, 'no plist left behind');
    assert.deepEqual(agentDirFiles(sandbox), [], 'a later run starts clean');
  });

  it('reports a failed restore with its own exit code and keeps the old plist on disk', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);
    const oldPlist = readFileSync(plistPath(sandbox));

    // Every bootstrap fails, so the restore of the old job fails as well.
    const result = run(INSTALL, [], baseEnv(sandbox, { FAKE_BOOTSTRAP_FAIL_ALL: '1' }));

    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes(RECOVERY_FAILED), result.stderr);
    assert.deepEqual(readFileSync(plistPath(sandbox)), oldPlist, 'old plist kept for recovery');
    assert.equal(existsSync(path.join(sandbox.record, 'loaded')), false, 'job is not loaded');
  });

  // Catchable signals only: SIGKILL cannot be trapped, so no shell can roll back after it.
  const CATCHABLE_SIGNALS = ['HUP', 'INT', 'TERM'];
  const OLD_INTERVAL = '259200';
  const NEW_INTERVAL = '3600';

  function replaceEnv(sandbox, sig, extra = {}) {
    return baseEnv(sandbox, {
      CLICKMOJI_BACKUP_INTERVAL_SECONDS: NEW_INTERVAL,
      FAKE_SIGNAL_SIG: sig,
      ...extra,
    });
  }

  // The loaded state is a copy of the bootstrapped plist, so this checks which definition is loaded.
  function assertLoadedDefinition(sandbox, expected) {
    const loaded = path.join(sandbox.record, 'loaded');
    assert.ok(existsSync(loaded), 'a job is loaded');
    assert.deepEqual(readFileSync(loaded), expected, 'the loaded job is the expected definition');
  }

  function assertOldAgentRestored(sandbox, result, sig, oldPlist) {
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`прервано сигналом ${sig}`), result.stderr);
    assert.equal(result.stderr.includes(RECOVERY_FAILED), false, result.stderr);
    assert.deepEqual(
      readFileSync(plistPath(sandbox)),
      oldPlist,
      'old plist restored byte for byte'
    );
    assertLoadedDefinition(sandbox, oldPlist);
    assert.deepEqual(agentDirFiles(sandbox), [`${LABEL}.plist`], 'no temporary copies left');
  }

  for (const sig of CATCHABLE_SIGNALS) {
    it(`restores the old plist and loaded job when ${sig} lands during bootout`, () => {
      const sandbox = makeSandbox();
      linkMainCheckout(sandbox);
      assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);
      const oldPlist = readFileSync(plistPath(sandbox));

      const result = run(INSTALL, [], replaceEnv(sandbox, sig, { FAKE_SIGNAL_VERB: 'bootout' }));

      assertOldAgentRestored(sandbox, result, sig, oldPlist);
      const changing = launchctlCalls(sandbox)
        .map((line) => line.split(' ')[0])
        .filter((verb) => verb === 'bootout' || verb === 'bootstrap');
      assert.deepEqual(changing.slice(-2), ['bootout', 'bootstrap'], 'old job reloaded once');
    });

    it(`restores the old plist and loaded job when ${sig} lands as the new bootstrap fails`, () => {
      const sandbox = makeSandbox();
      linkMainCheckout(sandbox);
      assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);
      const oldPlist = readFileSync(plistPath(sandbox));

      const result = run(
        INSTALL,
        [],
        replaceEnv(sandbox, sig, {
          FAKE_SIGNAL_VERB: 'bootstrap',
          FAKE_SIGNAL_WHEN: `<integer>${NEW_INTERVAL}</integer>`,
          FAKE_SIGNAL_RESULT: 'fail',
        })
      );

      assertOldAgentRestored(sandbox, result, sig, oldPlist);
      const changing = launchctlCalls(sandbox)
        .map((line) => line.split(' ')[0])
        .filter((verb) => verb === 'bootout' || verb === 'bootstrap');
      assert.deepEqual(
        changing.slice(-3),
        ['bootout', 'bootstrap', 'bootstrap'],
        'bootout, the signalled bootstrap, then the restore'
      );
    });

    it(`unloads the new job and restores the old one when ${sig} lands as the new bootstrap succeeds`, () => {
      // The new job is loaded when the signal arrives. Leaving it loaded against the restored file
      // would be the bug, so the rollback must bootout it before it bootstraps the old job again.
      const sandbox = makeSandbox();
      linkMainCheckout(sandbox);
      assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);
      const oldPlist = readFileSync(plistPath(sandbox));

      const result = run(
        INSTALL,
        [],
        replaceEnv(sandbox, sig, {
          FAKE_SIGNAL_VERB: 'bootstrap',
          FAKE_SIGNAL_WHEN: `<integer>${NEW_INTERVAL}</integer>`,
        })
      );

      assertOldAgentRestored(sandbox, result, sig, oldPlist);
      const changing = launchctlCalls(sandbox)
        .map((line) => line.split(' ')[0])
        .filter((verb) => verb === 'bootout' || verb === 'bootstrap');
      assert.deepEqual(
        changing.slice(-4),
        ['bootout', 'bootstrap', 'bootout', 'bootstrap'],
        'bootout, new bootstrap, bootout of the new job, restore'
      );
    });

    it(`leaves no agent and no plist when ${sig} lands during the first install`, () => {
      const sandbox = makeSandbox();
      linkMainCheckout(sandbox);

      const result = run(
        INSTALL,
        [],
        baseEnv(sandbox, {
          FAKE_SIGNAL_SIG: sig,
          FAKE_SIGNAL_VERB: 'bootstrap',
          FAKE_SIGNAL_WHEN: `<integer>${OLD_INTERVAL}</integer>`,
        })
      );

      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(`прервано сигналом ${sig}`), result.stderr);
      assert.equal(result.stderr.includes(RECOVERY_FAILED), false, result.stderr);
      assert.equal(existsSync(path.join(sandbox.record, 'loaded')), false, 'not loaded');
      assert.equal(existsSync(plistPath(sandbox)), false, 'no plist left behind');
      assert.deepEqual(agentDirFiles(sandbox), [], 'a later run starts clean');
    });
  }

  it('removes the agent, is idempotent, and keeps the status file and copies', () => {
    const sandbox = makeSandbox();
    linkMainCheckout(sandbox);
    assert.equal(run(INSTALL, [], baseEnv(sandbox)).status, 0);
    const logDir = path.join(sandbox.home, 'Library', 'Logs', 'clickmoji-backup');
    writeFileSync(path.join(logDir, 'status.tsv'), 'kept\n');

    const first = run(UNINSTALL, [], baseEnv(sandbox));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(plistPath(sandbox)), false);
    assert.equal(existsSync(path.join(sandbox.record, 'loaded')), false);

    const second = run(UNINSTALL, [], baseEnv(sandbox));
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readText(path.join(logDir, 'status.tsv')), 'kept\n');
  });
});
