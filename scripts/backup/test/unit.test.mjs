// Unit tests: configuration, retention, report comparison, status line, pins and argv.
import assert from 'node:assert/strict';
import { fixtureUrl } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ConfigError,
  libpqEnv,
  LIBPQ_ENV_NAMES,
  loadConfig,
  loadConfirmConfig,
  parseCliArgs,
  parseDockerTimeout,
  parseEncryptFlag,
  parseRetentionCount,
  REPO_ROOT,
} from '../config.mjs';
import { Ledger, LedgerError } from '../ledger.mjs';
import { DockerRunner } from '../docker.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import {
  POSTGRES_BASE_DIGEST,
  POSTGRES_BASE_IMAGE,
  TOOLS_IMAGE,
  DROP_THRESHOLD_PERCENT,
  DEFAULT_RETENTION_COUNT,
  ENCRYPTED_CONFIRM_STATE_NAME,
  EXIT,
} from '../constants.mjs';
import { verifyBackupDirGitIgnored } from '../git.mjs';
import { listBackups } from '../pipeline.mjs';
import {
  CONTAINER_DIR,
  cleanupArgs,
  dumpArgs,
  encryptArgs,
  verifyArgs,
  buildImageArgs,
  inspectImageArgs,
  versionArgs,
} from '../docker.mjs';
import {
  compareIdentities,
  findDrops,
  parseCounts,
  parseIdentities,
  parseMigration,
  ReportError,
} from '../compare.mjs';
import { formatStatusLine } from '../status.mjs';
import { selectRetention, selectTransitionRetention } from '../retention.mjs';
import { HERE, makeProjectRepo, makeSandbox, syntheticDatabase } from './helpers.mjs';

const VALID_RECIPIENT = `age1${'q'.repeat(58)}`;

describe('config', () => {
  const sandbox = makeSandbox();
  const recipientFile = sandbox.recipientFile;
  const base = () => ({
    DATABASE_URL: syntheticDatabase().url,
    BACKUP_DIR: sandbox.backupDir,
    BACKUP_STATUS_FILE: sandbox.statusFile,
    BACKUP_ENCRYPT: '1',
    BACKUP_AGE_RECIPIENT_FILE: recipientFile,
  });

  it('fails without a database address and does not echo it', () => {
    const env = base();
    delete env.DATABASE_URL;
    assert.throws(
      () => loadConfig(env),
      (error) => error instanceof ConfigError && error.message === 'DATABASE_URL не задан'
    );
  });

  it('rejects a non-postgres scheme without echoing the address', () => {
    const env = { ...base(), DATABASE_URL: fixtureUrl('mysql://h/db', 'u', 'secret') };
    assert.throws(
      () => loadConfig(env),
      (error) => !error.message.includes('secret') && !error.message.includes('mysql://')
    );
  });

  it('requires absolute paths for backup dir, status file and recipient', () => {
    assert.throws(
      () => loadConfig({ ...base(), BACKUP_DIR: 'relative/dir' }),
      /BACKUP_DIR: нужен абсолютный путь/
    );
    assert.throws(
      () => loadConfig({ ...base(), BACKUP_STATUS_FILE: '' }),
      /BACKUP_STATUS_FILE не задан/
    );
  });

  it('allows gitignored backup dir inside repo while refusing status file and tmpdir inside repo', () => {
    const inside = path.join(REPO_ROOT, 'backups');
    const config = loadConfig({ ...base(), BACKUP_DIR: inside });
    assert.equal(config.backupDir, inside);
    assert.throws(
      () => loadConfig({ ...base(), BACKUP_STATUS_FILE: path.join(REPO_ROOT, 'status.log') }),
      /BACKUP_STATUS_FILE: путь внутри репозитория/
    );
    assert.throws(
      () => loadConfig({ ...base(), TMPDIR: path.join(REPO_ROOT, 'tmp') }),
      /TMPDIR: путь внутри репозитория/
    );
    assert.throws(
      () => loadConfig({ ...base(), TMPDIR: path.join(sandbox.backupDir, 'tmp') }),
      /TMPDIR: путь внутри репозитория/
    );
  });

  it('defaults to unencrypted mode without requiring BACKUP_AGE_RECIPIENT_FILE', () => {
    const env = base();
    delete env.BACKUP_ENCRYPT;
    delete env.BACKUP_AGE_RECIPIENT_FILE;
    const config = loadConfig(env);
    assert.equal(config.encrypt, false);
    assert.equal(config.recipientFile, null);
    assert.equal(config.recipient, null);
    assert.equal(config.keepCount, DEFAULT_RETENTION_COUNT);
  });

  it('parses BACKUP_ENCRYPT, BACKUP_RETENTION_COUNT and CLI args strictly', () => {
    assert.equal(parseEncryptFlag(undefined), false);
    assert.equal(parseEncryptFlag('0'), false);
    assert.equal(parseEncryptFlag('1'), true);
    assert.equal(parseEncryptFlag('true'), true);
    assert.throws(() => parseEncryptFlag('maybe'), ConfigError);

    assert.equal(parseRetentionCount(undefined), 2);
    assert.equal(parseRetentionCount(' 7 '), 7);
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      assert.throws(() => parseRetentionCount(bad), ConfigError, `rejects ${bad}`);
    }

    assert.deepEqual(parseCliArgs([]), { allowRowDrop: false });
    assert.deepEqual(parseCliArgs(['--allow-row-drop']), { allowRowDrop: true });
    assert.deepEqual(
      parseCliArgs(['--confirm-encrypted-restore', 'clickmoji-20261124T120000Z.dump.age']),
      { allowRowDrop: false, confirmEncryptedRestore: 'clickmoji-20261124T120000Z.dump.age' }
    );
    assert.deepEqual(
      parseCliArgs(['--confirm-encrypted-restore=clickmoji-20261124T120000Z.dump.age']),
      { allowRowDrop: false, confirmEncryptedRestore: 'clickmoji-20261124T120000Z.dump.age' }
    );
    for (const badArgs of [
      ['--unknown'],
      ['--confirm-encrypted-restore'],
      ['--confirm-encrypted-restore', ''],
      ['--confirm-encrypted-restore='],
      ['--confirm-encrypted-restore', '--allow-row-drop'],
      ['--allow-row-drop', '--confirm-encrypted-restore', 'clickmoji-20261124T120000Z.dump.age'],
      ['--confirm-encrypted-restore', 'a.dump.age', '--confirm-encrypted-restore', 'b.dump.age'],
    ]) {
      assert.throws(() => parseCliArgs(badArgs), ConfigError, `rejects ${badArgs.join(' ')}`);
    }
  });

  it('loadConfirmConfig requires only BACKUP_DIR and BACKUP_STATUS_FILE, not DATABASE_URL or age keys', () => {
    const confirm = loadConfirmConfig({
      BACKUP_DIR: sandbox.backupDir,
      BACKUP_STATUS_FILE: sandbox.statusFile,
    });
    assert.equal(confirm.backupDir, sandbox.backupDir);
    assert.equal(confirm.statusFile, sandbox.statusFile);
    assert.throws(
      () =>
        loadConfirmConfig({
          BACKUP_DIR: 'relative/backups',
          BACKUP_STATUS_FILE: sandbox.statusFile,
        }),
      /BACKUP_DIR: нужен абсолютный путь/
    );
    assert.throws(
      () =>
        loadConfirmConfig({
          BACKUP_DIR: sandbox.backupDir,
          BACKUP_STATUS_FILE: path.join(REPO_ROOT, 'status.log'),
        }),
      /BACKUP_STATUS_FILE: путь внутри репозитория/
    );
  });

  it('refuses paths that docker --mount cannot carry', () => {
    assert.throws(() => loadConfig({ ...base(), BACKUP_DIR: '/tmp/a,b' }), /запрещённые символы/);
  });

  it('accepts exactly one age recipient', () => {
    const config = loadConfig(base());
    assert.match(config.recipient, /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/);
    assert.equal(config.dockerBin, 'docker');
  });

  it('rejects a recipient file with zero or two keys, without printing it', () => {
    const bad = (text) => () => loadConfig(base(), { readFile: () => text });
    assert.throws(bad(''), (error) => error instanceof ConfigError);
    assert.throws(
      bad(`${VALID_RECIPIENT}\n${VALID_RECIPIENT}\n`),
      (error) => !error.message.includes('age1q')
    );
    assert.throws(bad('AGE-SECRET-KEY-1ABC'), (error) => !error.message.includes('AGE-SECRET'));
  });

  it('maps the address to libpq variables: host, port, database, user, password, ssl', () => {
    assert.deepEqual(
      libpqEnv(
        fixtureUrl('postgresql://db.example.invalid/db?sslmode=require&schema=x', 'u', 'p%40x')
      ),
      {
        PGSSLMODE: 'require',
        PGHOST: 'db.example.invalid',
        PGPORT: '5432',
        PGDATABASE: 'db',
        PGUSER: 'u',
        PGPASSWORD: 'p@x',
      }
    );
  });

  it('maps localhost to the host gateway for containers and keeps channel binding', () => {
    const env = libpqEnv(
      fixtureUrl(
        'postgresql://localhost:6543/db?schema=public&sslmode=disable&channel_binding=require',
        'u',
        'p'
      )
    );
    assert.equal(env.PGHOST, 'host.docker.internal');
    assert.equal(env.PGPORT, '6543');
    assert.equal(env.PGSSLMODE, 'disable');
    assert.equal(env.PGCHANNELBINDING, 'require');
    assert.equal('schema' in env, false, 'Prisma-only parameter is dropped');
  });

  it('refuses a connection parameter it cannot pass to libpq, without echoing its value', () => {
    assert.throws(
      () => libpqEnv(fixtureUrl('postgresql://h/db?pgbouncer=true&sslmode=require', 'u', 'p')),
      (error) =>
        error instanceof ConfigError &&
        error.message === 'DATABASE_URL: параметр pgbouncer не поддерживается' &&
        !error.message.includes('true')
    );
  });

  it('only ever yields names libpq reads, and every one is forwarded by name', () => {
    const env = libpqEnv(
      fixtureUrl(
        'postgresql://h/db?sslmode=require&sslrootcert=/x/ca.pem&connect_timeout=5&application_name=b',
        'u',
        'p'
      )
    );
    for (const name of Object.keys(env)) assert.ok(LIBPQ_ENV_NAMES.includes(name), name);
    assert.equal(env.PGSSLROOTCERT, '/x/ca.pem');
    assert.equal(env.PGCONNECT_TIMEOUT, '5');
    assert.equal(env.PGAPPNAME, 'b');
  });
});

describe('retention', () => {
  const day = (n, encrypted = true) => {
    const time = new Date(Date.UTC(2026, 10, 24, 12) - n * 86_400_000);
    const stamp = time
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    return {
      name: `clickmoji-${stamp}${encrypted ? '.dump.age' : '.dump'}`,
      time,
      encrypted,
    };
  };

  it('keeps exactly 2 newest of 10 copies by default', () => {
    const entries = Array.from({ length: 10 }, (_, i) => day(i));
    const { keep, remove } = selectRetention(entries);
    assert.deepEqual(keep, [entries[0].name, entries[1].name]);
    assert.equal(remove.length, 8);
  });

  it('keeps everything when there are fewer copies than the limit', () => {
    const entries = [day(0)];
    assert.deepEqual(selectRetention(entries).remove, []);
  });

  it('recognizes both .dump and .dump.age across multiple copies per day, excludes temp/orphans, and keeps prior-version meta compatibility', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-mixed-ret-'));
    try {
      mkdirSync(path.join(dir, 'meta'), { recursive: true });
      const completed = [
        'clickmoji-20261124T120000Z.dump',
        'clickmoji-20261124T090000Z.dump.age',
        'clickmoji-20261123T120000Z.dump',
        'clickmoji-20261122T120000Z.dump.age',
      ];
      for (const f of completed) {
        writeFileSync(path.join(dir, f), 'x');
        // Omit `encrypted` on one legacy .dump.age entry to confirm prior-version compatibility.
        const meta =
          f === 'clickmoji-20261122T120000Z.dump.age'
            ? {
                name: f,
                createdAt: '2026-11-22T12:00:00.000Z',
                sizeBytes: 1,
                sha256: '0'.repeat(64),
                verify: 'ok',
                migration: '20261101000000_init',
                counts: { a: 1 },
                flagged: [],
              }
            : { name: f, verify: 'ok', counts: { a: 1 } };
        writeFileSync(path.join(dir, 'meta', `${f}.json`), JSON.stringify(meta));
      }
      const unaccepted = [
        '.partial-clickmoji-20261125T120000Z.dump.age',
        '.partial-clickmoji-20261125T120000Z.dump',
        'dump.custom',
        'clickmoji-20261125T120000Z.dump.tmp',
        'clickmoji-20261124T060000Z.dump', // orphaned dump without meta/*.json
        'clickmoji-20261124T030000Z.dump.age', // legacy suspicious copy
      ];
      for (const f of unaccepted) writeFileSync(path.join(dir, f), 'x');
      writeFileSync(
        path.join(dir, 'meta', 'clickmoji-20261124T030000Z.dump.age.json'),
        JSON.stringify({
          name: 'clickmoji-20261124T030000Z.dump.age',
          verify: 'suspicious',
          counts: { a: 1 },
        })
      );

      const listed = listBackups(dir);
      assert.equal(listed.length, 4, 'only recognized completed and accepted copies are listed');
      const { keep, remove } = selectRetention(listed, 2);
      assert.deepEqual(keep.sort(), [
        'clickmoji-20261124T090000Z.dump.age',
        'clickmoji-20261124T120000Z.dump',
      ]);
      assert.deepEqual(remove.sort(), [
        'clickmoji-20261122T120000Z.dump.age',
        'clickmoji-20261123T120000Z.dump',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the default retention constant of 2 without weekly or monthly tiers', () => {
    assert.equal(DEFAULT_RETENTION_COUNT, 2);
    const entries = Array.from({ length: 10 }, (_, i) => day(i));
    assert.equal(selectRetention(entries, 5).keep.length, 5);
  });

  it('B2 transition retention: preserves up to N plain copies + first .age, fills only free N slots with other .age (max N+1, never N+2), and pins confirmed copy on cutover including N=1', () => {
    const p3 = day(6, false);
    const p2 = day(5, false); // older plain
    const p1 = day(4, false); // newer plain
    const e1 = day(3, true); // first encrypted of transition
    const e2 = day(2, true); // second encrypted
    const e3 = day(1, true); // newest encrypted

    // First encrypted run (unconfirmed): N=2 plain + 1 encrypted (N+1 = 3)
    const first = selectTransitionRetention({
      entries: [p2, p1, e1],
      keepCount: 2,
      encrypt: true,
      confirmed: false,
    });
    assert.equal(first.waitingForConfirmation, true);
    assert.deepEqual(first.keep.sort(), [p2.name, p1.name, e1.name].sort());
    assert.deepEqual(first.remove, []);

    // Repeated unconfirmed runs when plainKept === N (N=2): keep N plain + first encrypted (e1), prune e2 and e3 (never N+2)
    const repeated = selectTransitionRetention({
      entries: [p2, p1, e1, e2, e3],
      keepCount: 2,
      encrypt: true,
      confirmed: false,
    });
    assert.equal(repeated.waitingForConfirmation, true);
    assert.deepEqual(repeated.keep.sort(), [p2.name, p1.name, e1.name].sort());
    assert.deepEqual(repeated.remove, [e2.name, e3.name]);

    // N=1 unconfirmed: keeps 1 plain + first encrypted (N+1 = 2), prunes newer unconfirmed e2
    const n1Unconfirmed = selectTransitionRetention({
      entries: [p1, e1, e2],
      keepCount: 1,
      encrypt: true,
      confirmed: false,
    });
    assert.equal(n1Unconfirmed.waitingForConfirmation, true);
    assert.deepEqual(n1Unconfirmed.keep.sort(), [p1.name, e1.name].sort());
    assert.deepEqual(n1Unconfirmed.remove, [e2.name]);

    // When plainKept < N, other .age copies fill ONLY free slots in normal limit N (never exceeding N)
    const freeSlots = selectTransitionRetention({
      entries: [p1, e1, e2, e3],
      keepCount: 3,
      encrypt: true,
      confirmed: false,
    });
    assert.equal(freeSlots.waitingForConfirmation, true);
    assert.deepEqual(freeSlots.keep.sort(), [p1.name, e1.name, e3.name].sort());
    assert.deepEqual(freeSlots.remove, [e2.name]);

    // N=2 with plainKept=1 has 0 free slots after p1 + e1, so e2 is pruned (total = N = 2)
    const zeroFreeSlots = selectTransitionRetention({
      entries: [p1, e1, e2],
      keepCount: 2,
      encrypt: true,
      confirmed: false,
    });
    assert.deepEqual(zeroFreeSlots.keep.sort(), [p1.name, e1.name].sort());
    assert.deepEqual(zeroFreeSlots.remove, [e2.name]);

    // Excess plaintext (>N) still caps plaintext at N without deleting the newest N plaintext copies
    const excessPlain = selectTransitionRetention({
      entries: [p3, p2, p1, e1],
      keepCount: 2,
      encrypt: true,
      confirmed: false,
    });
    assert.deepEqual(excessPlain.keep.sort(), [p2.name, p1.name, e1.name].sort());
    assert.deepEqual(excessPlain.remove, [p3.name]);

    // Pre-transition encrypted copy older than newest plain is pruned when N+1 is full
    const eOld = day(7, true);
    const withOldEnc = selectTransitionRetention({
      entries: [eOld, p2, p1, e1, e2],
      keepCount: 2,
      encrypt: true,
      confirmed: false,
    });
    assert.deepEqual(withOldEnc.keep.sort(), [p2.name, p1.name, e1.name].sort());
    assert.deepEqual(withOldEnc.remove, [eOld.name, e2.name]);

    // Confirmed cutover (N=2): keeps confirmed e1 + newest e4, removes intermediate e3 before plain p2/p1
    const e4 = day(0, true);
    const afterConfirm = selectTransitionRetention({
      entries: [p2, p1, e1, e3, e4],
      keepCount: 2,
      encrypt: true,
      confirmed: true,
      confirmedFile: e1.name,
    });
    assert.equal(afterConfirm.waitingForConfirmation, false);
    assert.deepEqual(afterConfirm.keep.sort(), [e1.name, e4.name].sort());
    assert.deepEqual(afterConfirm.remove, [e3.name, p2.name, p1.name]);

    // Confirmed cutover (N=1): confirmed e1 takes priority over newly published e2; removes e2 before p1
    const afterConfirmN1 = selectTransitionRetention({
      entries: [p1, e1, e2],
      keepCount: 1,
      encrypt: true,
      confirmed: true,
      confirmedFile: e1.name,
    });
    assert.equal(afterConfirmN1.waitingForConfirmation, false);
    assert.deepEqual(afterConfirmN1.keep, [e1.name]);
    assert.deepEqual(afterConfirmN1.remove, [e2.name, p1.name]);

    // Confirmed without a matching encrypted copy fails closed
    assert.throws(() =>
      selectTransitionRetention({
        entries: [p1, e1],
        keepCount: 1,
        encrypt: true,
        confirmed: true,
        confirmedFile: 'clickmoji-20261120T000000Z.dump.age',
      })
    );
  });
});

describe('git check-ignore and main-checkout destination guard', () => {
  it('accepts main checkout backups/ (also from worktree) and refuses non-ignored, worktree, foreign repo, external, symlink, and unavailable git', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-git-guard-'));
    try {
      const { repo: mainRepo, backupDir: ignored } = makeProjectRepo(path.join(tmp, 'main-repo'), {
        copyScripts: false,
      });
      const worktree = path.join(tmp, 'linked-wt');
      assert.equal(
        spawnSync('git', ['-C', mainRepo, 'worktree', 'add', '-q', worktree, '-b', 'wt']).status,
        0
      );
      const { backupDir: foreignBackups } = makeProjectRepo(path.join(tmp, 'foreign-repo'), {
        copyScripts: false,
      });
      const { backupDir: wrongNameBackups } = makeProjectRepo(path.join(tmp, 'wrong-name-repo'), {
        projectName: 'other-project',
        copyScripts: false,
      });
      const outside = path.join(tmp, 'outside-backups');

      // Main checkout backups/ passes from both mainRepo and linked worktree
      const ok = verifyBackupDirGitIgnored({ backupDir: ignored, projectRoot: mainRepo });
      assert.equal(ok.ok, true);
      assert.equal(ok.inRepo, true);
      const okFromWt = verifyBackupDirGitIgnored({ backupDir: ignored, projectRoot: worktree });
      assert.equal(okFromWt.ok, true);

      // Linked worktree's own backups/ fails even though it has .gitignore /backups/
      const wtOwn = verifyBackupDirGitIgnored({
        backupDir: path.join(worktree, 'backups'),
        projectRoot: worktree,
      });
      assert.equal(wtOwn.ok, false);
      assert.equal(wtOwn.key, 'notMainBackups');
      assert.equal(wtOwn.exit, EXIT.failed);

      // Foreign repo, wrong project identity, external path, and non-backups subdir fail
      assert.equal(
        verifyBackupDirGitIgnored({ backupDir: foreignBackups, projectRoot: worktree }).key,
        'notMainBackups'
      );
      assert.equal(
        verifyBackupDirGitIgnored({
          backupDir: wrongNameBackups,
          projectRoot: path.dirname(wrongNameBackups),
        }).key,
        'notMainBackups'
      );
      assert.equal(
        verifyBackupDirGitIgnored({ backupDir: outside, projectRoot: worktree }).key,
        'notMainBackups'
      );
      assert.equal(
        verifyBackupDirGitIgnored({
          backupDir: path.join(mainRepo, 'plain-backups'),
          projectRoot: mainRepo,
        }).key,
        'notMainBackups'
      );

      // Repo root and .git directory fail
      assert.equal(
        verifyBackupDirGitIgnored({ backupDir: mainRepo, projectRoot: mainRepo }).key,
        'notMainBackups'
      );
      assert.equal(
        verifyBackupDirGitIgnored({
          backupDir: path.join(mainRepo, '.git', 'backups'),
          projectRoot: mainRepo,
        }).key,
        'notIgnored'
      );

      // Symlink pointing to backups or unignored directory fails
      const unignoredTarget = path.join(mainRepo, 'exposed');
      mkdirSync(unignoredTarget);
      const link = path.join(tmp, 'alias-backups');
      symlinkSync(unignoredTarget, link);
      assert.equal(
        verifyBackupDirGitIgnored({ backupDir: link, projectRoot: mainRepo }).key,
        'notMainBackups'
      );

      // Symlinked meta/ inside mainRepo/backups fails
      mkdirSync(ignored, { recursive: true });
      symlinkSync(unignoredTarget, path.join(ignored, 'meta'));
      assert.equal(
        verifyBackupDirGitIgnored({ backupDir: ignored, projectRoot: mainRepo }).key,
        'notIgnored'
      );
      rmSync(path.join(ignored, 'meta'));

      // Exact targetPaths catch negated rules under /backups/*
      writeFileSync(
        path.join(mainRepo, '.gitignore'),
        '/backups/*\n!/backups/clickmoji-20261125T034000Z.dump\n!/backups/.partial-clickmoji-20261125T034001Z.dump\n!/backups/meta/\n!/backups/meta/clickmoji-20261125T034002Z.dump.json\n!/backups/meta/.partial-clickmoji-20261125T034003Z.dump.json\n'
      );
      assert.equal(
        verifyBackupDirGitIgnored({
          backupDir: ignored,
          projectRoot: mainRepo,
          targetPaths: [path.join(ignored, 'clickmoji-20261125T034000Z.dump')],
        }).key,
        'notIgnored'
      );
      assert.equal(
        verifyBackupDirGitIgnored({
          backupDir: ignored,
          projectRoot: mainRepo,
          targetPaths: [path.join(ignored, '.partial-clickmoji-20261125T034001Z.dump')],
        }).key,
        'notIgnored'
      );
      assert.equal(
        verifyBackupDirGitIgnored({
          backupDir: ignored,
          projectRoot: mainRepo,
          targetPaths: [path.join(ignored, 'meta', 'clickmoji-20261125T034002Z.dump.json')],
        }).key,
        'notIgnored'
      );
      assert.equal(
        verifyBackupDirGitIgnored({
          backupDir: ignored,
          projectRoot: mainRepo,
          targetPaths: [
            path.join(ignored, 'meta', '.partial-clickmoji-20261125T034003Z.dump.json'),
          ],
        }).key,
        'notIgnored'
      );

      // Exact check catches negated rules targeting confirmation state files under /backups/meta/
      writeFileSync(
        path.join(mainRepo, '.gitignore'),
        `/backups/*\n!/backups/meta/\n!/backups/meta/${ENCRYPTED_CONFIRM_STATE_NAME}\n`
      );
      assert.equal(
        verifyBackupDirGitIgnored({ backupDir: ignored, projectRoot: mainRepo }).key,
        'notIgnored'
      );
      writeFileSync(
        path.join(mainRepo, '.gitignore'),
        `/backups/*\n!/backups/meta/\n!/backups/meta/.partial-${ENCRYPTED_CONFIRM_STATE_NAME}\n`
      );
      assert.equal(
        verifyBackupDirGitIgnored({ backupDir: ignored, projectRoot: mainRepo }).key,
        'notIgnored'
      );

      // Non-ignored mainRepo/backups fails with notIgnored
      writeFileSync(path.join(mainRepo, '.gitignore'), '');
      const bad = verifyBackupDirGitIgnored({ backupDir: ignored, projectRoot: mainRepo });
      assert.equal(bad.ok, false);
      assert.equal(bad.key, 'notIgnored');
      assert.equal(bad.exit, EXIT.failed);

      // Unavailable git fails closed
      const missingGit = verifyBackupDirGitIgnored({
        backupDir: ignored,
        projectRoot: mainRepo,
        gitBin: '/nonexistent/git-bin',
      });
      assert.equal(missingGit.ok, false);
      assert.equal(missingGit.key, 'git');
      assert.equal(missingGit.exit, EXIT.unavailable);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('report comparison', () => {
  it('parses identities, migration and counts; malformed reports throw', () => {
    assert.equal(parseIdentities('a\tid int4 NO\n').get('a'), 'id int4 NO');
    assert.equal(parseMigration('20261124000000_add\n'), '20261124000000_add');
    assert.equal(parseCounts('a\t10\n').get('a'), 10);
    assert.throws(() => parseIdentities('no-tab-here\n'), ReportError);
    assert.throws(
      () => parseIdentities(''),
      ReportError,
      'an empty identity report is unreadable, not a pass'
    );
    assert.throws(() => parseIdentities('a\tx\na\ty\n'), ReportError);
    assert.throws(() => parseMigration(''), ReportError);
    assert.throws(() => parseCounts('a\t-1\n'), ReportError);
    assert.throws(() => parseCounts('a\t1.5\n'), ReportError);
  });

  it('reports missing, changed and extra tables', () => {
    const source = parseIdentities('a\tid int4 NO\nb\tid int4 NO\n');
    assert.deepEqual(
      compareIdentities(source, parseIdentities('a\tid int4 NO\nb\tid int4 NO\n')),
      []
    );
    assert.deepEqual(compareIdentities(source, parseIdentities('a\tid int4 NO\n')), ['missing:b']);
    assert.deepEqual(compareIdentities(source, parseIdentities('a\tid text NO\nb\tid int4 NO\n')), [
      'changed:a',
    ]);
    assert.deepEqual(
      compareIdentities(source, parseIdentities('a\tid int4 NO\nb\tid int4 NO\nc\tid int4 NO\n')),
      ['extra:c']
    );
  });

  it('flags a drop above the threshold, not exactly at it', () => {
    assert.equal(DROP_THRESHOLD_PERCENT, 20);
    const previous = new Map([
      ['a', 100],
      ['b', 100],
      ['c', 0],
    ]);
    const flagged = findDrops(
      previous,
      new Map([
        ['a', 79],
        ['b', 80],
        ['c', 0],
      ])
    );
    assert.deepEqual(
      flagged.map((d) => d.table),
      ['a']
    );
    assert.deepEqual(
      findDrops(
        previous,
        new Map([
          ['a', 100],
          ['b', 100],
        ])
      ),
      []
    );
  });
});

describe('status line', () => {
  it('formats date, outcome and detail, and refuses secret-like details', () => {
    const line = formatStatusLine({
      now: new Date('2026-11-24T12:00:00.000Z'),
      outcome: 'ok',
      detail: 'size=10 verify=ok',
    });
    assert.equal(line, '2026-11-24T12:00:00.000Z\tok\tsize=10 verify=ok\n');
    assert.throws(() =>
      formatStatusLine({
        now: new Date(),
        outcome: 'failed',
        detail: fixtureUrl('postgresql://h/d', 'u', 'p'),
      })
    );
  });
});

describe('pins and docker arguments', () => {
  const containerFile = (name) => readFileSync(path.join(CONTAINER_DIR, name), 'utf8');

  it('pins the base image by a verified sha256 digest', () => {
    assert.match(POSTGRES_BASE_DIGEST, /^sha256:[0-9a-f]{64}$/);
    assert.equal(POSTGRES_BASE_IMAGE, `postgres:17-alpine@${POSTGRES_BASE_DIGEST}`);
  });

  it('the tools Dockerfile is built from the same digest and installs age', () => {
    const fromLines = containerFile('Dockerfile.tools')
      .split('\n')
      .filter((line) => line.startsWith('FROM '));
    assert.deepEqual(fromLines, [`FROM ${POSTGRES_BASE_IMAGE}`]);
    assert.match(containerFile('Dockerfile.tools'), /RUN apk add --no-cache age\b/);
    assert.doesNotMatch(containerFile('Dockerfile.tools'), /:latest/);
  });

  it('every container step runs the same tools image', () => {
    const dir = '/tmp/clickmoji-x';
    const runs = [
      dumpArgs({ name: 'n1', workDir: dir }),
      verifyArgs({ name: 'n2', workDir: dir }),
      encryptArgs({ name: 'n3', workDir: dir, recipientFile: '/tmp/r.txt' }),
      cleanupArgs({ name: 'n4', workDir: dir }),
    ];
    for (const args of runs) {
      assert.equal(args.filter((arg) => arg === TOOLS_IMAGE).length, 1, args.join(' '));
      assert.equal(
        args.filter((arg) => arg.includes('postgres:')).length,
        0,
        'no direct base image reference'
      );
    }
    assert.deepEqual(inspectImageArgs(), ['image', 'inspect', TOOLS_IMAGE]);
    assert.ok(buildImageArgs().includes(TOOLS_IMAGE));
    assert.deepEqual(versionArgs(), ['version', '--format', '{{.Server.Version}}']);
  });

  it('no docker argument carries the database address, host or password', () => {
    const db = syntheticDatabase();
    const dir = '/tmp/clickmoji-x';
    const all = [
      ...buildImageArgs(),
      ...dumpArgs({ name: 'n1', workDir: dir }),
      ...verifyArgs({ name: 'n2', workDir: dir }),
      ...encryptArgs({ name: 'n3', workDir: dir, recipientFile: '/tmp/r.txt' }),
      ...cleanupArgs({ name: 'n4', workDir: dir }),
    ].join('\n');
    assert.ok(!all.includes(db.password));
    assert.ok(!all.includes(db.host));
    assert.ok(!all.includes('postgresql://'));
  });

  it('forwards DATABASE_URL and every libpq variable by name only, never with a value', () => {
    for (const args of [
      dumpArgs({ name: 'n1', workDir: '/tmp/x' }),
      verifyArgs({ name: 'n2', workDir: '/tmp/x' }),
    ]) {
      const forwarded = args.flatMap((arg, i) => (arg === '-e' ? [args[i + 1]] : []));
      assert.deepEqual(forwarded, ['DATABASE_URL', ...LIBPQ_ENV_NAMES]);
      // Name-only: the element after each -e is exactly the variable name.
      for (const [i, arg] of args.entries()) {
        if (arg === '-e') assert.doesNotMatch(args[i + 1], /=/, 'no value in -e');
      }
      assert.equal(
        args.some((arg) => arg.includes('=') && arg.startsWith('PG')),
        false,
        'no PG variable with a value'
      );
      assert.equal(
        args.some((arg) => arg.startsWith('DATABASE_URL=') || arg.startsWith('postgres')),
        false,
        'no URL value'
      );
    }
  });

  it('encrypt and cleanup containers forward no source variable at all', () => {
    for (const args of [
      encryptArgs({ name: 'n3', workDir: '/tmp/x', recipientFile: '/tmp/r.txt' }),
      cleanupArgs({ name: 'n4', workDir: '/tmp/x' }),
    ]) {
      assert.equal(args.includes('-e'), false, args.join(' '));
      assert.equal(
        args.some((arg) => arg.includes('DATABASE_URL') || /^PG/.test(arg)),
        false,
        args.join(' ')
      );
    }
  });

  it('the dump and verify steps run the committed scripts, with no address in their command', () => {
    assert.equal(dumpArgs({ name: 'n1', workDir: '/tmp/x' }).at(-1), '/opt/backup/dump.sh');
    assert.equal(verifyArgs({ name: 'n2', workDir: '/tmp/x' }).at(-1), '/opt/backup/verify.sh');
    for (const script of ['dump.sh', 'verify.sh']) {
      const text = containerFile(script);
      // DATABASE_URL may appear in code only as the statement that drops it from the environment.
      const mentions = text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#') && line.includes('DATABASE_URL'));
      assert.deepEqual(mentions, ['unset DATABASE_URL'], `${script} only unsets the URL`);
      assert.doesNotMatch(text, /postgres(ql)?:\/\//, `${script} holds no URL literal`);
      assert.doesNotMatch(text, /--dbname|\$PG_?URL/, `${script} passes no connection string`);
    }
  });

  it('the sandbox helper lives outside the repository', () => {
    assert.ok(!HERE.startsWith(REPO_ROOT + path.sep) || HERE.includes('scripts'));
  });
});

describe('docker calls are bounded and a hung client is killed (B2, round 6)', () => {
  it('a management call that never answers is killed and reported as timed out, not as an answer', async () => {
    const runner = new DockerRunner({ bin: process.execPath, containerEnv: {}, env: process.env });
    const started = Date.now();
    const result = await runner.manage(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.equal(result.code, 124, 'a timed-out call is a failure, never a zero exit');
    assert.ok(
      elapsed < 4000,
      `the client was reaped on the kill, not after the fallback (${elapsed} ms)`
    );
  });

  it('BACKUP_DOCKER_TIMEOUT_MS: unset means the default, a bad value is a configuration error', () => {
    assert.equal(parseDockerTimeout(undefined), 20_000);
    assert.equal(parseDockerTimeout(' 1500 '), 1500);
    for (const bad of ['0', '50', '600001', 'abc', '1.5', '-1']) {
      assert.throws(() => parseDockerTimeout(bad), ConfigError, `rejects ${bad}`);
    }
  });
});

describe('the ledger reads an older name-only file as pending (round 6)', () => {
  it('a names-only ledger gives every name the pending state, which only a sighting can settle', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-ledger-'));
    try {
      const name = 'clickmoji-backup-dump-0123456789ab';
      writeFileSync(path.join(dir, '.backup.ledger'), JSON.stringify({ containers: [name] }));
      assert.deepEqual(new Ledger(dir).entries(), [{ name, state: 'pending' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('states are written with the names, and an unknown state fails closed', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-ledger-'));
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const ledger = new Ledger(dir);
      const name = 'clickmoji-backup-dump-0123456789ab';
      ledger.add(name);
      ledger.setState(name, 'exists');
      assert.deepEqual(ledger.entries(), [{ name, state: 'exists' }]);
      writeFileSync(
        path.join(dir, '.backup.ledger'),
        JSON.stringify({ containers: [name], states: { [name]: 'gone' } })
      );
      assert.throws(() => ledger.entries(), LedgerError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
