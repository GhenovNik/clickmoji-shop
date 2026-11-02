// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const tsxBin = resolve(root, 'node_modules', '.bin', 'tsx');
const backupScript = resolve(root, 'scripts', 'db-backup.ts');
const restoreScript = resolve(root, 'scripts', 'db-restore.ts');

let workDir: string;
let argsFile: string;
let env: NodeJS.ProcessEnv;

function dockerArgs(): string[] {
  return readFileSync(argsFile, 'utf8').trim().split('\n');
}

function runScript(
  script: string,
  args: string[],
  overrides: Record<string, string | undefined> = {}
) {
  return spawnSync(tsxBin, [script, ...args], {
    cwd: workDir,
    env: { ...env, ...overrides } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'clickmoji-db-backup-test-'));
  const binDir = join(workDir, 'bin');
  argsFile = join(workDir, 'docker-args.txt');
  mkdirSync(binDir, { recursive: true });

  const fakeDocker = join(binDir, 'docker');
  writeFileSync(
    fakeDocker,
    '#!/bin/sh\n: > "$DOCKER_ARGS_FILE"\nfor arg in "$@"; do printf \'%s\\n\' "$arg" >> "$DOCKER_ARGS_FILE"; done\nexit "${DOCKER_EXIT_CODE:-0}"\n'
  );
  chmodSync(fakeDocker, 0o755);

  env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/clickmoji?schema=public',
    DOCKER_ARGS_FILE: argsFile,
  };
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('database backup and restore use the PostgreSQL 17 client image', () => {
  it('runs pg_dump in postgres:17-alpine', { timeout: 60_000 }, () => {
    const result = runScript(backupScript, ['nightly']);

    expect(result.status, result.stderr).toBe(0);
    const args = dockerArgs();
    expect(args).toContain('postgres:17-alpine');
    expect(args).not.toContain('postgres:16-alpine');
    expect(args.at(-1)).toContain('pg_dump');
  });

  it('runs pg_restore in postgres:17-alpine', { timeout: 60_000 }, () => {
    const backups = join(workDir, 'backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, 'clickmoji-20261030-120000.dump'), 'synthetic');
    expect(existsSync(argsFile)).toBe(true);

    const result = runScript(restoreScript, []);

    expect(result.status, result.stderr).toBe(0);
    const args = dockerArgs();
    expect(args).toContain('postgres:17-alpine');
    expect(args).not.toContain('postgres:16-alpine');
    expect(args.at(-1)).toContain('pg_restore');
  });

  it('reports a non-zero docker exit as a backup failure', { timeout: 60_000 }, () => {
    const result = runScript(backupScript, ['nightly'], { DOCKER_EXIT_CODE: '3' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Backup failed');
  });

  it('fails closed without DATABASE_URL and never calls docker', { timeout: 60_000 }, () => {
    const unusedArgsFile = join(workDir, 'docker-args-unused.txt');
    const result = runScript(backupScript, ['nightly'], {
      DATABASE_URL: '',
      DOCKER_ARGS_FILE: unusedArgsFile,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL is not set');
    expect(existsSync(unusedArgsFile)).toBe(false);
  });
});
