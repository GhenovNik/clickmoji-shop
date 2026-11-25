// Offline tests for the pre-merge backup (AGE-1667). docker is a fake on PATH that records each call's
// argv and only whether the PG* variables are set. The DSN below is synthetic and contains a secret
// marker that must never appear in any argv, in the fake's log, or in the script's output (except the
// ::add-mask:: lines, which the runner uses to hide values).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { POSTGRES_BASE_IMAGE } from '../../backup/constants.mjs';
import { LIBPQ_ENV_NAMES, libpqEnv } from '../../backup/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREMERGE = path.join(HERE, '..');
const SECRET = 'SYNTH-pw-7f3a9c-do-not-log';
const SYNTH_DSN = `postgresql://premerge_synth:${SECRET}@127.0.0.1:5432/clickmoji?sslmode=require`;
const NAME = 'neon-prod-premigrate-20261124-093000.dump';

// The fake docker: logs one line per call (argv, then PG* presence), then acts on the call.
//   dump    writes a non-empty file into the mounted host directory, unless FAKE_DUMP_FAIL is set
//   restore exits 0, unless FAKE_RESTORE_FAIL is set
const FAKE_DOCKER = `#!/bin/sh
{
  printf 'CALL'
  for a; do printf ' [%s]' "$a"; done
  printf '\\n'
  printf 'PG_PASSWORD_SET=%s PG_HOST_SET=%s\\n' "\${PGPASSWORD:+yes}" "\${PGHOST:+yes}"
} >> "$FAKE_LOG"
case "$1" in
  network|stop|rm|exec) exit 0 ;;
  run)
    if [ "$2" = "-d" ]; then echo scratchid; exit 0; fi
    host=""; prev=""; last=""
    for a; do
      if [ "$prev" = "-v" ]; then host="\${a%%:/backups}"; fi
      prev="$a"; last="$a"
    done
    case "$*" in
      *pg_dump*)
        [ -z "$FAKE_DUMP_FAIL" ] || exit 1
        printf 'dump-bytes' > "$host/$last"
        exit 0 ;;
      *pg_restore*)
        [ -z "$FAKE_RESTORE_FAIL" ] || exit 1
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

describe('prod-backup.sh and libpq-env.mjs', () => {
  let dir;
  let bin;
  let backups;
  let log;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'premerge-backup-'));
    bin = path.join(dir, 'bin');
    backups = path.join(dir, 'backups');
    log = path.join(dir, 'docker.log');
    mkdirSync(bin);
    mkdirSync(backups);
    writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
    chmodSync(path.join(bin, 'docker'), 0o755);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (mode, extraEnv = {}, fileName = NAME) => {
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: dir,
      FAKE_LOG: log,
      ...extraEnv,
    };
    if (extraEnv.DATABASE_URL === undefined) delete env.DATABASE_URL;
    return spawnSync('bash', [path.join(PREMERGE, 'prod-backup.sh'), mode, fileName, backups], {
      env,
      encoding: 'utf8',
    });
  };
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  const dockerCalls = () => calls().filter((line) => line.startsWith('CALL'));
  const leftoverLibpqFiles = () => readdirSync(dir).filter((f) => f.startsWith('premerge-libpq.'));

  it('dump and restore succeed with the synthetic DSN, and the secret stays out of every argv', () => {
    const dump = run('dump', { DATABASE_URL: SYNTH_DSN });
    assert.equal(dump.status, 0, dump.stdout + dump.stderr);
    assert.match(dump.stdout, /backup created/);
    assert.ok(
      existsSync(path.join(backups, NAME)),
      'dump file was written into the backups directory'
    );

    const restore = run('restore');
    assert.equal(restore.status, 0, restore.stdout + restore.stderr);
    assert.match(restore.stdout, /backup restored into a scratch PostgreSQL 17/);
    assert.equal(
      existsSync(path.join(backups, NAME)),
      false,
      'restored dump is deleted afterwards'
    );

    const everything = calls().join('\n');
    assert.doesNotMatch(everything, new RegExp(SECRET), 'no argv or PG_* value carries the secret');
    assert.doesNotMatch(everything, /db\.synthetic\.invalid/, 'the host is not in any argv');
    assert.doesNotMatch(everything, /postgresql:\/\//, 'the DSN is not in any argv');
    assert.doesNotMatch(everything, /premerge_synth/, 'the user is not in any argv');
  });

  it('every docker run gets --log-driver none and only variable names for the source connection', () => {
    assert.equal(run('dump', { DATABASE_URL: SYNTH_DSN }).status, 0);
    const runs = dockerCalls().filter((line) => line.includes('[run]'));
    assert.ok(runs.length >= 1);
    for (const line of runs) {
      assert.match(line, /\[--log-driver\] \[none\]/, line);
    }
    const dump = dockerCalls().find((line) => line.includes('pg_dump'));
    assert.ok(dump, 'dump call present');
    assert.match(dump, /\[-e\] \[PGHOST\]/);
    assert.match(dump, /\[-e\] \[PGPASSWORD\]/);
    assert.doesNotMatch(dump, /\[-e\] \[DATABASE_URL\]/, 'DATABASE_URL is not forwarded');
    assert.doesNotMatch(dump, /PGPASSWORD=/, 'no PGPASSWORD=value pair in argv');
    assert.match(
      calls().join('\n'),
      /PG_PASSWORD_SET=yes/,
      'the value reaches docker only through the environment'
    );
  });

  it('the image is the pinned digest from constants.mjs (dump and restore use the same tag)', () => {
    assert.equal(run('dump', { DATABASE_URL: SYNTH_DSN }).status, 0);
    assert.equal(run('restore').status, 0);
    const script = readFileSync(path.join(PREMERGE, 'prod-backup.sh'), 'utf8');
    assert.match(
      script,
      new RegExp(`IMAGE='${POSTGRES_BASE_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`)
    );
    for (const line of dockerCalls().filter((l) => l.includes('[run]'))) {
      assert.match(line, /postgres:17-alpine@sha256:f9cf3e1f/, line);
    }
  });

  it('stdout and stderr hold no secret outside ::add-mask:: lines, and the masks cover the password', () => {
    const result = run('dump', { DATABASE_URL: SYNTH_DSN });
    assert.equal(result.status, 0);
    const visible = (result.stdout + result.stderr)
      .split('\n')
      .filter((line) => !line.startsWith('::add-mask::'))
      .join('\n');
    assert.doesNotMatch(visible, new RegExp(SECRET));
    assert.match(
      result.stdout,
      new RegExp(`^::add-mask::${SECRET}$`, 'm'),
      'password is masked for the runner'
    );
  });

  it('the connection file is removed when the dump finishes', () => {
    assert.equal(run('dump', { DATABASE_URL: SYNTH_DSN }).status, 0);
    assert.deepEqual(leftoverLibpqFiles(), []);
  });

  describe('negative controls', () => {
    it('refuses a missing DATABASE_URL before any docker call', () => {
      const result = run('dump', { DATABASE_URL: '' });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /PREMERGE_PROD_DATABASE_URL secret is required/);
      assert.deepEqual(dockerCalls(), []);
    });

    it('refuses a non-postgres scheme before any docker call', () => {
      const result = run('dump', { DATABASE_URL: SYNTH_DSN.replace('postgresql://', 'mysql://') });
      assert.equal(result.status, 1);
      assert.match(result.stdout + result.stderr, /not a supported connection/);
      assert.deepEqual(dockerCalls(), []);
    });

    it('refuses an unsupported URL parameter and never echoes it', () => {
      const result = run('dump', { DATABASE_URL: `${SYNTH_DSN}&target_session_attrs=read-write` });
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET));
      assert.deepEqual(dockerCalls(), []);
    });

    it('refuses a password with a line break (percent-encoded newline)', () => {
      const dsn = `postgresql://premerge_synth:${SECRET}%0Aevil@127.0.0.1:5432/clickmoji`;
      const result = run('dump', { DATABASE_URL: dsn });
      assert.equal(result.status, 1);
      assert.match(result.stdout + result.stderr, /control character/);
      assert.deepEqual(dockerCalls(), []);
    });

    it('a failed dump publishes nothing and does not start the restore', () => {
      const result = run('dump', { DATABASE_URL: SYNTH_DSN, FAKE_DUMP_FAIL: '1' });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /backup failed; migration not applied/);
      assert.equal(existsSync(path.join(backups, NAME)), false);
      assert.equal(
        calls().some((line) => line.includes('pg_restore')),
        false
      );
    });

    it('a failed restore check stops the run with the migration not applied', () => {
      assert.equal(run('dump', { DATABASE_URL: SYNTH_DSN }).status, 0);
      const result = run('restore', { FAKE_RESTORE_FAIL: '1' });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /backup restore check failed; migration not applied/);
    });

    it('restore refuses a missing dump and never asks for the source connection', () => {
      const result = run('restore');
      assert.equal(result.status, 1, 'no dump file was written, so restore refuses');
      assert.match(result.stdout, /backup file is missing/);
    });

    it('refuses a file name with path separators before any docker call', () => {
      const result = run('dump', { DATABASE_URL: SYNTH_DSN }, '../escape.dump');
      assert.equal(result.status, 2);
      assert.match(result.stdout, /unexpected characters/);
      assert.deepEqual(dockerCalls(), []);
    });
  });
});

describe('libpq-env.mjs', () => {
  it('--names lists exactly the libpq names of the backup CLI', () => {
    const result = spawnSync(process.execPath, [path.join(PREMERGE, 'libpq-env.mjs'), '--names'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout.trim().split('\n'), [...LIBPQ_ENV_NAMES]);
  });

  it('writes the same values as libpqEnv, shell-quoted, with a 0600 file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'premerge-libpq-'));
    try {
      const out = path.join(dir, 'env.sh');
      const result = spawnSync(
        process.execPath,
        [path.join(PREMERGE, 'libpq-env.mjs'), '--out', out],
        {
          env: {
            DATABASE_URL: `postgresql://u%27x:p%27w@127.0.0.1:6543/app?sslmode=require`,
          },
          encoding: 'utf8',
        }
      );
      assert.equal(result.status, 0, result.stderr);
      const text = readFileSync(out, 'utf8');
      const expected = libpqEnv(
        'postgresql://u%27x:p%27w@127.0.0.1:6543/app?sslmode=require'
      );
      assert.match(text, /^export PGUSER='u'\\''x'$/m, 'single quote is escaped, not evaluated');
      assert.match(text, /^export PGPASSWORD='p'\\''w'$/m);
      assert.equal(expected.PGPORT, '6543');
      assert.match(text, /^export PGPORT='6543'$/m);
      assert.equal(statSync(out).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
