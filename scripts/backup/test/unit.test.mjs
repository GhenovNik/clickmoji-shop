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
import { selectRetention } from '../retention.mjs';
import { HERE, syntheticDatabase, makeSandbox } from './helpers.mjs';

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
    assert.throws(() => parseCliArgs(['--unknown']), ConfigError);
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

  it('recognizes both .dump and .dump.age across multiple copies per day and excludes temp names', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-mixed-ret-'));
    try {
      const files = [
        'clickmoji-20261124T120000Z.dump',
        'clickmoji-20261124T090000Z.dump.age',
        'clickmoji-20261123T120000Z.dump',
        'clickmoji-20261122T120000Z.dump.age',
        '.partial-clickmoji-20261125T120000Z.dump.age',
        '.partial-clickmoji-20261125T120000Z.dump',
        'dump.custom',
        'clickmoji-20261125T120000Z.dump.tmp',
      ];
      for (const f of files) writeFileSync(path.join(dir, f), 'x');
      const listed = listBackups(dir);
      assert.equal(listed.length, 4, 'only recognized completed formats are listed');
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
});

describe('git check-ignore destination guard', () => {
  it('accepts gitignored path and refuses non-ignored, .git, symlinked-unignored and unavailable git', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'clickmoji-git-guard-'));
    try {
      const repo = path.join(tmp, 'repo');
      mkdirSync(repo);
      assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
      writeFileSync(path.join(repo, '.gitignore'), '/backups/\n');
      assert.equal(spawnSync('git', ['-C', repo, 'add', '.gitignore']).status, 0);
      assert.equal(
        spawnSync('git', [
          '-C',
          repo,
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

      // Ignored directory (even before creation) passes
      const ignored = path.join(repo, 'backups');
      const ok = verifyBackupDirGitIgnored({ backupDir: ignored });
      assert.equal(ok.ok, true);
      assert.equal(ok.inRepo, true);

      // Non-ignored directory fails
      const bad = verifyBackupDirGitIgnored({ backupDir: path.join(repo, 'plain-backups') });
      assert.equal(bad.ok, false);
      assert.equal(bad.key, 'notIgnored');
      assert.equal(bad.exit, EXIT.failed);

      // Repo root and .git directory fail
      assert.equal(verifyBackupDirGitIgnored({ backupDir: repo }).key, 'notIgnored');
      assert.equal(
        verifyBackupDirGitIgnored({ backupDir: path.join(repo, '.git', 'backups') }).key,
        'notIgnored'
      );

      // Symlink pointing to an unignored directory inside the repo fails on its physical path
      const unignoredTarget = path.join(repo, 'exposed');
      mkdirSync(unignoredTarget);
      const link = path.join(tmp, 'alias-backups');
      symlinkSync(unignoredTarget, link);
      assert.equal(verifyBackupDirGitIgnored({ backupDir: link }).key, 'notIgnored');

      // Unavailable git fails closed
      const missingGit = verifyBackupDirGitIgnored({
        backupDir: ignored,
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
