// Unit tests: configuration, retention, report comparison, status line, pins and argv.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, libpqEnv, LIBPQ_ENV_NAMES, loadConfig, REPO_ROOT } from '../config.mjs';
import {
  POSTGRES_BASE_DIGEST,
  POSTGRES_BASE_IMAGE,
  TOOLS_IMAGE,
  DROP_THRESHOLD_PERCENT,
  RETENTION,
} from '../constants.mjs';
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
    const env = { ...base(), DATABASE_URL: 'mysql://u:secret@h/db' };
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

  it('refuses backup paths inside the repository', () => {
    const inside = path.join(REPO_ROOT, 'backups');
    assert.throws(
      () => loadConfig({ ...base(), BACKUP_DIR: inside }),
      /BACKUP_DIR: путь внутри репозитория/
    );
    assert.throws(
      () => loadConfig({ ...base(), BACKUP_STATUS_FILE: path.join(REPO_ROOT, 'status.log') }),
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
      libpqEnv('postgresql://u:p%40x@db.example.invalid/db?sslmode=require&schema=x'),
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
      'postgresql://u:p@localhost:6543/db?schema=public&sslmode=disable&channel_binding=require'
    );
    assert.equal(env.PGHOST, 'host.docker.internal');
    assert.equal(env.PGPORT, '6543');
    assert.equal(env.PGSSLMODE, 'disable');
    assert.equal(env.PGCHANNELBINDING, 'require');
    assert.equal('schema' in env, false, 'Prisma-only parameter is dropped');
  });

  it('refuses a connection parameter it cannot pass to libpq, without echoing its value', () => {
    assert.throws(
      () => libpqEnv('postgresql://u:p@h/db?pgbouncer=true&sslmode=require'),
      (error) =>
        error instanceof ConfigError &&
        error.message === 'DATABASE_URL: параметр pgbouncer не поддерживается' &&
        !error.message.includes('true')
    );
  });

  it('only ever yields names libpq reads, and every one is forwarded by name', () => {
    const env = libpqEnv(
      'postgresql://u:p@h/db?sslmode=require&sslrootcert=/x/ca.pem&connect_timeout=5&application_name=b'
    );
    for (const name of Object.keys(env)) assert.ok(LIBPQ_ENV_NAMES.includes(name), name);
    assert.equal(env.PGSSLROOTCERT, '/x/ca.pem');
    assert.equal(env.PGCONNECT_TIMEOUT, '5');
    assert.equal(env.PGAPPNAME, 'b');
  });
});

describe('retention', () => {
  const day = (n) => ({
    name: `d${String(n).padStart(3, '0')}`,
    time: new Date(Date.UTC(2026, 10, 24, 12) - n * 86_400_000),
  });

  it('keeps exactly 14 of 100 daily copies: 7 daily, 4 weekly, 3 monthly', () => {
    const entries = Array.from({ length: 100 }, (_, i) => day(i));
    const { keep, remove } = selectRetention(entries);
    assert.equal(keep.length, 14);
    assert.equal(remove.length, 86);
    for (let i = 0; i < 7; i += 1)
      assert.ok(keep.includes(`d${String(i).padStart(3, '0')}`), `newest day ${i} kept`);
  });

  it('keeps everything when there are fewer than 14 copies in few periods', () => {
    const entries = [day(0), day(1), day(2)];
    assert.deepEqual(selectRetention(entries).remove, []);
  });

  it('keeps one copy per day for the daily tier, even with several per day', () => {
    const entries = [];
    for (let n = 0; n < 100; n += 1) {
      entries.push({ name: `a${n}`, time: new Date(day(n).time.getTime() + 3_600_000) });
      entries.push({ name: `b${n}`, time: new Date(day(n).time.getTime()) });
    }
    const { keep } = selectRetention(entries);
    assert.equal(keep.length, 14);
    const dayKeys = new Set(
      entries.filter((e) => keep.includes(e.name)).map((e) => e.time.toISOString().slice(0, 10))
    );
    assert.equal(dayKeys.size, 14, 'no two kept copies share a calendar day');
  });

  it('applies the policy constants', () => {
    assert.deepEqual(RETENTION, { daily: 7, weekly: 4, monthly: 3 });
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
      formatStatusLine({ now: new Date(), outcome: 'failed', detail: 'postgresql://u:p@h/d' })
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

  it('forwards every libpq variable by name only, never with a value', () => {
    for (const args of [
      dumpArgs({ name: 'n1', workDir: '/tmp/x' }),
      verifyArgs({ name: 'n2', workDir: '/tmp/x' }),
    ]) {
      const forwarded = args.flatMap((arg, i) => (arg === '-e' ? [args[i + 1]] : []));
      assert.deepEqual(forwarded, [...LIBPQ_ENV_NAMES]);
      assert.equal(
        args.some((arg) => arg.includes('=') && arg.startsWith('PG')),
        false,
        'no PG variable with a value'
      );
      assert.equal(
        args.some((arg) => arg.startsWith('DATABASE_URL')),
        false,
        'no URL variable'
      );
    }
  });

  it('the dump and verify steps run the committed scripts, with no address in their command', () => {
    assert.equal(dumpArgs({ name: 'n1', workDir: '/tmp/x' }).at(-1), '/opt/backup/dump.sh');
    assert.equal(verifyArgs({ name: 'n2', workDir: '/tmp/x' }).at(-1), '/opt/backup/verify.sh');
    for (const script of ['dump.sh', 'verify.sh']) {
      const text = containerFile(script);
      assert.doesNotMatch(text, /DATABASE_URL|postgres(ql)?:\/\//, `${script} takes no URL`);
      assert.doesNotMatch(text, /--dbname|\$PG_?URL/, `${script} passes no connection string`);
    }
  });

  it('the sandbox helper lives outside the repository', () => {
    assert.ok(!HERE.startsWith(REPO_ROOT + path.sep) || HERE.includes('scripts'));
  });
});
