// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GHSA_OTHER,
  OTHER_URL,
  REPO_ROOT,
  advisory,
  initialAllowlistJson,
  liveFull,
  liveProduction,
  node,
  reportJson,
} from './test-helpers';

const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'audit-check.ts');

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'audit-check-e2e-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A stand-in for npm that answers the two FR-2 calls from files the test controls. */
function installFakeNpm(): string {
  const directory = tempDir();
  const script = path.join(directory, 'npm');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      'const production = args.includes("--omit=dev");',
      'if (process.env.AUDIT_FAKE_LOG) {',
      '  fs.appendFileSync(process.env.AUDIT_FAKE_LOG, JSON.stringify({ args, env: process.env }) + "\\n");',
      '}',
      'const mode = process.env.AUDIT_FAKE_MODE || "reports";',
      'const file = production ? process.env.AUDIT_FAKE_PROD : process.env.AUDIT_FAKE_FULL;',
      'const status = Number(production ? process.env.AUDIT_FAKE_EXIT_PROD : process.env.AUDIT_FAKE_EXIT_FULL || "1");',
      'process.stdout.write(fs.readFileSync(file, "utf8"));',
      'process.exit(mode === "status2" && !production ? 2 : status);',
      '',
    ].join('\n')
  );
  chmodSync(script, 0o755);
  return directory;
}

/** A copy of the entrypoint and its modules in a scratch root, so a broken allowlist can be tested. */
function materializeScriptTree(allowlistJson: string): string {
  const root = tempDir();
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  cpSync(SCRIPT, path.join(root, 'scripts', 'audit-check.ts'));
  cpSync(path.join(REPO_ROOT, 'src', 'lib', 'audit'), path.join(root, 'src', 'lib', 'audit'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts') && !source.endsWith('test-helpers.ts'),
  });
  writeFileSync(path.join(root, 'audit-allowlist.json'), allowlistJson);
  return root;
}

interface RunOptions {
  full?: string;
  production?: string;
  mode?: string;
  root?: string;
}

function runScript(options: RunOptions = {}) {
  const directory = installFakeNpm();
  const fixtures = tempDir();
  const fullPath = path.join(fixtures, 'full.json');
  const productionPath = path.join(fixtures, 'prod.json');
  const logPath = path.join(fixtures, 'calls.log');
  writeFileSync(fullPath, options.full ?? liveFull());
  writeFileSync(productionPath, options.production ?? liveProduction());

  const result = spawnSync(
    TSX_BIN,
    [path.join(options.root ?? REPO_ROOT, 'scripts', 'audit-check.ts')],
    {
      cwd: options.root ?? REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
        NODE_ENV: 'production',
        npm_config_offline: 'true',
        npm_config_registry: 'http://127.0.0.1:9/',
        AUDIT_FAKE_FULL: fullPath,
        AUDIT_FAKE_PROD: productionPath,
        AUDIT_FAKE_LOG: logPath,
        AUDIT_FAKE_MODE: options.mode ?? 'reports',
        AUDIT_FAKE_EXIT_FULL: '1',
        AUDIT_FAKE_EXIT_PROD: '0',
      },
    }
  );

  const calls = existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> })
    : [];

  return { result, calls };
}

describe('AC-11 the real entrypoint under a fake npm', () => {
  it('exits 0 on the live fixture and prints the allowed advisory line', () => {
    const { result } = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('allowed advisory GHSA-vfj7-8cjw-p6xm');
    expect(result.stdout).toContain('braces');
    expect(result.stdout).toContain('2026-11-04');
  });

  it('calls npm twice with the pinned arguments and a sanitized environment', () => {
    const { result, calls } = runScript();

    expect(result.status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual([
      'audit',
      '--json',
      '--include=dev',
      '--include=optional',
      '--include=peer',
      '--offline=false',
      '--registry=https://registry.npmjs.org/',
      expect.stringContaining('--userconfig='),
      expect.stringContaining('--globalconfig='),
    ]);
    expect(calls[1].args).toContain('--omit=dev');
    for (const call of calls) {
      expect(Object.keys(call.env).filter((key) => /^npm_config_/i.test(key))).toEqual([]);
      expect(call.env).not.toHaveProperty('NODE_ENV');
    }
  });

  it('exits 1 with package, level and reason for an unresolved high advisory', () => {
    const full = reportJson({
      'other-pkg': node({
        name: 'other-pkg',
        via: [advisory({ name: 'other-pkg', url: OTHER_URL })],
      }),
    });

    const { result } = runScript({ full });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('blocking vulnerability');
    expect(result.stdout).toContain(GHSA_OTHER);
    expect(result.stdout).toContain('other-pkg');
    expect(result.stdout).toContain('severity high');
    expect(result.stdout).toContain('no allowlist entry');
  });

  it('exits 1 when the advisory url is not a GitHub advisory url', () => {
    const full = reportJson({
      braces: node({ via: [advisory({ url: 'https://example.com/GHSA-vfj7-8cjw-p6xm' })] }),
    });

    const { result } = runScript({ full });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('is not a GitHub Security Advisory URL');
  });

  it('exits 1 when the advisory severity exceeds the allowlist cap', () => {
    const full = reportJson({ braces: node({ via: [advisory({ severity: 'critical' })] }) });

    const { result } = runScript({ full });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('is above maxSeverity high');
  });

  it('exits 1 with the process error class when npm exits with status 2', () => {
    const { result } = runScript({ mode: 'status2' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('error [process]');
    expect(result.stdout).toContain('full report');
    expect(result.stdout).toContain('exited with status 2');
  });

  it('exits 1 with the schema error class when the allowlist violates its schema', () => {
    const root = materializeScriptTree('{\n  "version": 2,\n  "exceptions": []\n}\n');

    const { result } = runScript({ root });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('error [schema]');
    expect(result.stdout).toContain('version must be 1');
  });

  it('exits 1 when the allowlist file is missing', () => {
    const root = materializeScriptTree(initialAllowlistJson());
    rmSync(path.join(root, 'audit-allowlist.json'));

    const { result } = runScript({ root });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('error [schema]');
    expect(result.stdout).toContain('file is missing');
  });

  it('exits 1 without calling npm when the scratch project has an .npmrc', () => {
    const root = materializeScriptTree(initialAllowlistJson());
    writeFileSync(path.join(root, '.npmrc'), 'registry=http://127.0.0.1:9/\n');

    const { result, calls } = runScript({ root });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('error [config]');
    expect(calls).toHaveLength(0);
  });
});
