import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAuditCheck } from './run';
import { createNpmAuditRunner, NPM_REGISTRY, NPM_TIMEOUT_MS } from './npm-runner';
import {
  advisory,
  allowlistJson,
  EMPTY_PROD,
  entry,
  fakeRunner,
  fixturesRunner,
  initialAllowlistJson,
  liveFull,
  liveProduction,
  node,
  reportJson,
  text,
} from './test-helpers';
import type { ReportLabel } from './types';

const NOW = '2026-10-04T12:00:00.000Z';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'audit-check-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeNpm(directory: string, body: string): string {
  const file = path.join(directory, 'npm');
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function options(overrides: Partial<Parameters<typeof runAuditCheck>[0]> = {}) {
  return {
    runner: fixturesRunner(liveFull(), liveProduction()).runner,
    readAllowlistFile: () => initialAllowlistJson(),
    findProjectNpmrc: () => null,
    now: new Date(NOW),
    ...overrides,
  };
}

describe('AC-4 allowlist expiry in UTC', () => {
  it('AC-5 keeps the exception valid at 23:59:59.999Z of the expires day', async () => {
    const decision = await runAuditCheck(
      options({
        readAllowlistFile: () => initialAllowlistJson({ expires: '2026-10-04' }),
        now: new Date('2026-10-04T23:59:59.999Z'),
      })
    );

    expect(decision.exitCode).toBe(0);
    expect(text(decision)).toContain('2026-10-04');
  });

  it('AC-5 rejects the exception at 00:00:00.000Z of the next day', async () => {
    const decision = await runAuditCheck(
      options({
        readAllowlistFile: () => initialAllowlistJson({ expires: '2026-10-04' }),
        now: new Date('2026-10-05T00:00:00.000Z'),
      })
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('error [schema]');
    expect(text(decision)).toContain('exceptions[0].expires 2026-10-04 is in the past');
  });

  it('AC-5 rejects an expired exception even when its advisory is absent from the report', async () => {
    const cleanReport = reportJson({
      'low-pkg': node({
        name: 'low-pkg',
        severity: 'low',
        via: [advisory({ name: 'low-pkg', severity: 'low' })],
      }),
    });

    const decision = await runAuditCheck(
      options({
        runner: fixturesRunner(cleanReport, EMPTY_PROD).runner,
        readAllowlistFile: () => initialAllowlistJson({ expires: '2026-10-01' }),
        now: new Date(NOW),
      })
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('exceptions[0].expires 2026-10-01 is in the past');
  });

  it.each([['2026-02-30'], ['2026-13-01']])(
    'AC-5 rejects the impossible expires date %s',
    async (expires) => {
      const decision = await runAuditCheck(
        options({ readAllowlistFile: () => initialAllowlistJson({ expires }) })
      );

      expect(decision.exitCode).toBe(1);
      expect(text(decision)).toContain('must be an existing calendar date (YYYY-MM-DD)');
    }
  );
});

const malformedReports: Array<[string, string, string]> = [
  ['stdout is not JSON', 'not json at all', 'stdout is not valid JSON'],
  [
    'a report that carries an npm error field',
    JSON.stringify({
      error: { code: 'ECONNREFUSED', summary: 'request to https://registry.npmjs.org failed' },
    }),
    'report carries an npm error field',
  ],
  [
    'a report with auditReportVersion 1',
    JSON.stringify({ auditReportVersion: 1, vulnerabilities: {} }),
    'auditReportVersion must be 2',
  ],
  [
    'a missing auditReportVersion',
    JSON.stringify({ vulnerabilities: {} }),
    'auditReportVersion must be 2',
  ],
  [
    'vulnerabilities as an array',
    JSON.stringify({ auditReportVersion: 2, vulnerabilities: [] }),
    'vulnerabilities must be a JSON object',
  ],
  [
    'vulnerabilities as null',
    JSON.stringify({ auditReportVersion: 2, vulnerabilities: null }),
    'vulnerabilities must be a JSON object',
  ],
  [
    'a node without a name',
    reportJson({ braces: { severity: 'high', via: [advisory()] } }),
    'vulnerabilities.braces.name must be a string',
  ],
  [
    'a node whose name is not a string',
    reportJson({ braces: { name: 7, severity: 'high', via: [advisory()] } }),
    'vulnerabilities.braces.name must be a string',
  ],
  [
    'an unknown node severity',
    reportJson({ braces: node({ severity: 'severe' }) }),
    'vulnerabilities.braces.severity must be one of info, low, moderate, high, critical',
  ],
  [
    'a node without a severity',
    reportJson({ braces: { name: 'braces', via: [advisory()] } }),
    'vulnerabilities.braces.severity must be one of info, low, moderate, high, critical',
  ],
  [
    'an empty via array',
    reportJson({ braces: node({ via: [] }) }),
    'vulnerabilities.braces.via must be a non-empty array',
  ],
  [
    'a missing via array',
    reportJson({ braces: { name: 'braces', severity: 'high' } }),
    'vulnerabilities.braces.via must be a non-empty array',
  ],
  [
    'a via element that is a number',
    reportJson({ braces: node({ via: [7] }) }),
    'vulnerabilities.braces.via[0] must be a string or an advisory object',
  ],
  [
    'a via element that is null',
    reportJson({ braces: node({ via: [null] }) }),
    'vulnerabilities.braces.via[0] must be a string or an advisory object',
  ],
  [
    'an advisory without a name',
    reportJson({ braces: node({ via: [{ url: advisory().url, severity: 'high' }] }) }),
    'vulnerabilities.braces.via[0].name must be a string',
  ],
  [
    'an advisory whose name is not a string',
    reportJson({ braces: node({ via: [{ name: 7, severity: 'high' }] }) }),
    'vulnerabilities.braces.via[0].name must be a string',
  ],
  [
    'an advisory without a severity',
    reportJson({
      braces: node({ via: [{ name: 'braces', url: advisory().url }] }),
    }),
    'vulnerabilities.braces.via[0].severity must be one of info, low, moderate, high, critical',
  ],
  [
    'an advisory with an unknown severity',
    reportJson({ braces: node({ via: [{ name: 'braces', severity: 'severe' }] }) }),
    'vulnerabilities.braces.via[0].severity must be one of info, low, moderate, high, critical',
  ],
];

describe('AC-8 report format errors fail closed', () => {
  it.each(malformedReports)('rejects %s', async (_title, badStdout, expected) => {
    for (const label of ['full', 'production'] as ReportLabel[]) {
      const reportName = label === 'full' ? 'full report' : 'production report';
      const { runner } = fixturesRunner(
        label === 'full' ? badStdout : liveFull(),
        label === 'production' ? badStdout : liveProduction()
      );

      const decision = await runAuditCheck(options({ runner }));

      expect(decision.exitCode).toBe(1);
      expect(text(decision)).toContain('error [format]');
      expect(text(decision)).toContain(reportName);
      expect(text(decision)).toContain(expected);
    }
  });
});

describe('AC-9 npm process failures', () => {
  it('fails closed when npm cannot be started at all', async () => {
    const runner = createNpmAuditRunner({ command: path.join(tempDir(), 'missing-npm') });

    const decision = await runAuditCheck(options({ runner }));

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('error [process]');
    expect(text(decision)).toContain('full report');
    expect(text(decision)).toContain('ENOENT');
  });

  it('fails closed when npm is terminated by a signal even with a valid report on stdout', async () => {
    const command = fakeNpm(
      tempDir(),
      "process.stdout.write('{}'); process.kill(process.pid, 'SIGTERM');"
    );

    const decision = await runAuditCheck(
      options({ runner: createNpmAuditRunner({ command }), timeoutMs: 10_000 })
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('error [process]');
    expect(text(decision)).toContain('terminated by signal SIGTERM');
  });

  it('fails closed when npm exits with status 2 and a valid report on stdout', async () => {
    const command = fakeNpm(
      tempDir(),
      `process.stdout.write(${JSON.stringify(liveFull())}); process.exit(2);`
    );

    const decision = await runAuditCheck(
      options({ runner: createNpmAuditRunner({ command }), timeoutMs: 10_000 })
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('error [process]');
    expect(text(decision)).toContain('exited with status 2');
    expect(text(decision)).toContain('full report');
  });

  it('fails closed when only the second npm call breaks', async () => {
    const { runner } = fakeRunner((_call, index) => ({
      stdout: index === 0 ? liveFull() : liveProduction(),
      status: index === 0 ? 1 : 2,
    }));

    const decision = await runAuditCheck(options({ runner }));

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('error [process]');
    expect(text(decision)).toContain('production report');
    expect(text(decision)).toContain('exited with status 2');
  });

  it('treats exit status 1 with the same valid report as the normal path', async () => {
    const { runner } = fakeRunner((_call, index) => ({
      stdout: index === 0 ? liveFull() : liveProduction(),
      status: 1,
    }));

    const decision = await runAuditCheck(options({ runner }));

    expect(decision.exitCode).toBe(0);
    expect(text(decision)).toContain('allowed advisory GHSA-vfj7-8cjw-p6xm');
  });

  it('terminates a real npm child that overruns the timeout', async () => {
    const directory = tempDir();
    const marker = path.join(directory, 'late-marker.txt');
    const command = fakeNpm(
      directory,
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 3000); setTimeout(() => {}, 30000);`
    );

    const started = Date.now();
    const decision = await runAuditCheck(
      options({ runner: createNpmAuditRunner({ command }), timeoutMs: 1_000 })
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('error [process]');
    expect(text(decision)).toContain('timed out after 1000 ms');
    expect(Date.now() - started).toBeLessThan(2_500);

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it('fails closed when npm output exceeds the stdout buffer', async () => {
    const command = fakeNpm(tempDir(), "process.stdout.write('x'.repeat(4096)); process.exit(0);");

    const decision = await runAuditCheck(
      options({
        runner: createNpmAuditRunner({ command, maxOutputBytes: 1024 }),
        timeoutMs: 10_000,
      })
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('error [process]');
    expect(text(decision)).toContain('more than 1024 bytes of output');
  }, 20_000);
});

describe('AC-10 npm invocation isolation', () => {
  it('calls npm exactly twice with the pinned arguments and empty config files', async () => {
    const { runner, calls } = fixturesRunner(liveFull(), liveProduction());

    const decision = await runAuditCheck(options({ runner }));

    expect(decision.exitCode).toBe(0);
    expect(calls).toHaveLength(2);

    const userConfig = calls[0].args
      .find((arg) => arg.startsWith('--userconfig='))
      ?.slice('--userconfig='.length);
    const globalConfig = calls[0].args
      .find((arg) => arg.startsWith('--globalconfig='))
      ?.slice('--globalconfig='.length);

    expect(userConfig).toBeDefined();
    expect(globalConfig).toBeDefined();
    expect(userConfig).not.toBe(globalConfig);
    expect(calls[0].args).toEqual([
      'audit',
      '--json',
      '--include=dev',
      '--include=optional',
      '--include=peer',
      '--offline=false',
      `--registry=${NPM_REGISTRY}`,
      `--userconfig=${userConfig}`,
      `--globalconfig=${globalConfig}`,
    ]);
    const secondUserConfig = calls[1].args
      .find((arg) => arg.startsWith('--userconfig='))
      ?.slice('--userconfig='.length);
    const secondGlobalConfig = calls[1].args
      .find((arg) => arg.startsWith('--globalconfig='))
      ?.slice('--globalconfig='.length);

    expect(calls[1].args).toEqual([
      'audit',
      '--json',
      '--omit=dev',
      '--include=optional',
      '--include=peer',
      '--offline=false',
      `--registry=${NPM_REGISTRY}`,
      `--userconfig=${secondUserConfig}`,
      `--globalconfig=${secondGlobalConfig}`,
    ]);
    expect(calls[0].configFiles).toEqual({ userconfig: '', globalconfig: '' });
    expect(calls[0].timeoutMs).toBe(NPM_TIMEOUT_MS);
    expect(NPM_TIMEOUT_MS).toBe(120_000);
  });

  it('strips NODE_ENV and every npm_config variable from the child environment', async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      offline: process.env.npm_config_offline,
      registry: process.env.NPM_CONFIG_REGISTRY,
    };
    process.env.NODE_ENV = 'production';
    process.env.npm_config_offline = 'true';
    process.env.NPM_CONFIG_REGISTRY = 'http://127.0.0.1:9/';

    try {
      const { runner, calls } = fixturesRunner(liveFull(), liveProduction());

      const decision = await runAuditCheck(options({ runner }));

      expect(decision.exitCode).toBe(0);
      for (const call of calls) {
        expect(Object.keys(call.env).filter((key) => /^npm_config_/i.test(key))).toEqual([]);
        expect(call.env).not.toHaveProperty('NODE_ENV');
      }
      expect(process.env.NODE_ENV).toBe('production');
    } finally {
      if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.NODE_ENV;
      if (previous.offline === undefined) delete process.env.npm_config_offline;
      else process.env.npm_config_offline = previous.offline;
      if (previous.registry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
      else process.env.NPM_CONFIG_REGISTRY = previous.registry;
    }
  });

  it.each([['registry=http://127.0.0.1:9/'], ['offline=true'], ['dev=true'], ['# a comment only']])(
    'refuses to run npm when a project .npmrc exists (%s)',
    async (content) => {
      const directory = tempDir();
      const npmrc = path.join(directory, '.npmrc');
      writeFileSync(npmrc, content);

      const decision = await runAuditCheck(options({ findProjectNpmrc: () => npmrc }));

      expect(decision.exitCode).toBe(1);
      expect(text(decision)).toContain('error [config]');
      expect(text(decision)).toContain('.npmrc');
      expect(text(decision)).toContain(npmrc);
    }
  );

  it('never calls npm when the project .npmrc check fails', async () => {
    const npmrc = path.join(tempDir(), '.npmrc');
    writeFileSync(npmrc, 'offline=true');
    const { runner, calls } = fixturesRunner(liveFull(), liveProduction());

    const decision = await runAuditCheck(options({ runner, findProjectNpmrc: () => npmrc }));

    expect(decision.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('keeps audit scope out of the environment: production entries are not inherited', async () => {
    const { runner, calls } = fixturesRunner(liveFull(), liveProduction());

    await runAuditCheck(options({ runner, readAllowlistFile: () => allowlistJson([entry()]) }));

    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain('--include=dev');
    expect(calls[1].args).toContain('--omit=dev');
  });
});
