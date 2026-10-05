import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findExpiredEntry, parseAllowlist } from './allowlist';
import { decideAudit } from './decide';
import {
  buildAuditArgs,
  buildIsolatedEnv,
  NPM_TIMEOUT_MS,
  type AuditConfigFiles,
  type AuditRunner,
  type RunnerResult,
} from './npm-runner';
import { parseReport } from './report';
import { printable } from './text';
import { reportName, type Decision } from './types';

export interface RunAuditCheckOptions {
  readonly runner: AuditRunner;
  readonly readAllowlistFile: () => string | null;
  readonly findProjectNpmrc: () => string | null;
  readonly now?: Date;
  readonly timeoutMs?: number;
}

interface AuditCall {
  readonly label: 'full' | 'production';
  readonly args: string[];
}

function failure(errorClass: string, message: string): Decision {
  return { exitCode: 1, lines: [`audit-check: error [${errorClass}]: ${message}`] };
}

function processFailure(call: AuditCall, result: RunnerResult, timeoutMs: number): string | null {
  const name = reportName(call.label);

  if (result.error !== null) {
    return `${name} - npm audit could not be started: ${printable(result.error.message)}`;
  }

  if (result.timedOut) {
    return `${name} - npm audit timed out after ${timeoutMs} ms`;
  }

  if (result.overflow) {
    return `${name} - npm audit produced more than ${result.limitBytes} bytes of output`;
  }

  if (result.signal !== null) {
    return `${name} - npm audit was terminated by signal ${printable(result.signal)}`;
  }

  if (result.status !== 0 && result.status !== 1) {
    return `${name} - npm audit exited with status ${printable(result.status)}`;
  }

  return null;
}

export async function runAuditCheck(options: RunAuditCheckOptions): Promise<Decision> {
  const timeoutMs = options.timeoutMs ?? NPM_TIMEOUT_MS;

  const projectNpmrc = options.findProjectNpmrc();
  if (projectNpmrc !== null) {
    return failure(
      'config',
      `project .npmrc is not allowed: ${printable(projectNpmrc)} - remove it, or extend scripts/audit-check.ts together with its tests first`
    );
  }

  const rawAllowlist = options.readAllowlistFile();
  if (rawAllowlist === null) {
    return failure('schema', 'audit-allowlist.json - file is missing');
  }

  const allowlist = parseAllowlist(rawAllowlist);
  if (!allowlist.ok) {
    return failure(
      'schema',
      `audit-allowlist.json - ${allowlist.failure.field}: ${allowlist.failure.message}`
    );
  }

  const now = options.now ?? new Date();
  const expired = findExpiredEntry(allowlist.allowlist, now);
  if (expired !== null) {
    return failure(
      'schema',
      `audit-allowlist.json - exceptions[${expired.index}].expires ${expired.entry.expires} is in the past (now ${now.toISOString()})`
    );
  }

  const configDirectory = mkdtempSync(path.join(tmpdir(), 'audit-check-'));

  try {
    const configFiles: AuditConfigFiles = {
      userConfigPath: path.join(configDirectory, 'user.npmrc'),
      globalConfigPath: path.join(configDirectory, 'global.npmrc'),
    };
    writeFileSync(configFiles.userConfigPath, '');
    writeFileSync(configFiles.globalConfigPath, '');

    const fullCall: AuditCall = { label: 'full', args: buildAuditArgs('full', configFiles) };
    const productionCall: AuditCall = {
      label: 'production',
      args: buildAuditArgs('production', configFiles),
    };
    const calls = [fullCall, productionCall];
    const env = buildIsolatedEnv(process.env);

    const results: RunnerResult[] = [];
    for (const call of calls) {
      results.push(await options.runner(call.args, env, timeoutMs));
    }

    for (const [index, call] of calls.entries()) {
      const problem = processFailure(call, results[index], timeoutMs);
      if (problem !== null) {
        return failure('process', problem);
      }
    }

    const full = parseReport(fullCall.label, results[0].stdout);
    if (!full.ok) {
      return failure(
        'format',
        `${reportName(fullCall.label)} - ${full.failure.field}: ${full.failure.message}`
      );
    }

    const production = parseReport(productionCall.label, results[1].stdout);
    if (!production.ok) {
      return failure(
        'format',
        `${reportName(productionCall.label)} - ${production.failure.field}: ${production.failure.message}`
      );
    }

    return decideAudit({
      full: full.report,
      production: production.report,
      allowlist: allowlist.allowlist,
      now,
    });
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
}
