import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAllowlist } from './allowlist';
import { parseReport } from './report';
import { decideAudit } from './decide';
import { NPM_MAX_OUTPUT_BYTES, type AuditRunner, type RunnerResult } from './npm-runner';
import type { AuditReport, Decision, ReportLabel } from './types';

export const REPO_ROOT = process.cwd();
export const ALLOWLIST_FILE = path.join(REPO_ROOT, 'audit-allowlist.json');

export const GHSA_BRACES = 'GHSA-vfj7-8cjw-p6xm';
export const BRACES_URL = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
export const GHSA_OTHER = 'GHSA-2345-67qr-jmpx';
export const OTHER_URL = `https://github.com/advisories/${GHSA_OTHER}`;

export const NOW = '2026-10-04T12:00:00.000Z';
export const EXPIRES = '2026-11-04';

export function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, 'src', 'lib', 'audit', 'fixtures', name), 'utf8');
}

export function reportJson(vulnerabilities: Record<string, unknown>): string {
  return `${JSON.stringify(
    {
      auditReportVersion: 2,
      vulnerabilities,
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: Object.keys(vulnerabilities).length,
        },
      },
    },
    null,
    2
  )}\n`;
}

/** A report whose `vulnerabilities` object is written as raw JSON, so keys an object literal cannot own (`__proto__`) survive. */
export function reportWithRawVulnerabilities(vulnerabilitiesJson: string): string {
  return `{\n  "auditReportVersion": 2,\n  "vulnerabilities": ${vulnerabilitiesJson}\n}\n`;
}

export const EMPTY_PROD = reportJson({});

export function node(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'braces',
    severity: 'high',
    isDirect: false,
    via: [],
    effects: [],
    range: '*',
    nodes: ['node_modules/braces'],
    fixAvailable: false,
    ...fields,
  };
}

export function advisory(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 1240992,
    name: 'braces',
    dependency: 'braces',
    title: 'braces vulnerable to stack-exhaustion denial of service',
    url: BRACES_URL,
    severity: 'high',
    range: '<=3.0.3',
    ...fields,
  };
}

export function entry(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GHSA_BRACES,
    packages: ['braces'],
    reason: 'dev-only glob tooling, tracked in AGE-951',
    scope: 'dev',
    maxSeverity: 'high',
    expires: EXPIRES,
    issue: 'AGE-951',
    ...fields,
  };
}

export function allowlistJson(entries: unknown, rootFields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ version: 1, exceptions: entries, ...rootFields }, null, 2)}\n`;
}

export function initialAllowlistJson(overrides: Record<string, unknown> = {}): string {
  return allowlistJson([entry(overrides)]);
}

export function parseReportOrThrow(label: ReportLabel, raw: string): AuditReport {
  const parsed = parseReport(label, raw);
  if (!parsed.ok) {
    throw new Error(`fixture is not a valid ${label} report: ${parsed.failure.message}`);
  }
  return parsed.report;
}

export function decide(
  fullRaw: string,
  productionRaw: string,
  allowlistRaw: string,
  now: string = NOW
): Decision {
  const allowlist = parseAllowlist(allowlistRaw);
  if (!allowlist.ok) {
    throw new Error(`fixture is not a valid allowlist: ${allowlist.failure.message}`);
  }

  return decideAudit({
    full: parseReportOrThrow('full', fullRaw),
    production: parseReportOrThrow('production', productionRaw),
    allowlist: allowlist.allowlist,
    now: new Date(now),
  });
}

export function text(decision: Decision): string {
  return decision.lines.join('\n');
}

export function liveFull(): string {
  return readFixture('audit-full.json');
}

export function liveProduction(): string {
  return readFixture('audit-prod.json');
}

/** The saved live `npm audit --json` report with the single braces advisory severity replaced. */
export function liveFullWithAdvisorySeverity(severity: string, nodeSeverity?: string): string {
  const parsed = JSON.parse(liveFull()) as {
    vulnerabilities: Record<string, { severity: string; via: Record<string, unknown>[] }>;
  };

  for (const nodeValue of Object.values(parsed.vulnerabilities)) {
    if (nodeSeverity) {
      nodeValue.severity = nodeSeverity;
    }
    for (const viaItem of nodeValue.via) {
      if (typeof viaItem === 'object') {
        viaItem.severity = severity;
      }
    }
  }

  return reportJson(parsed.vulnerabilities as unknown as Record<string, unknown>);
}

export interface RecordedCall {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  configFiles: Record<string, string | null>;
}

function readConfigFile(value: string): string | null {
  try {
    return readFileSync(value, 'utf8');
  } catch {
    return null;
  }
}

/** A runner that records every invocation and answers with the fixture the test asks for. */
export function fakeRunner(respond: (call: RecordedCall, index: number) => Partial<RunnerResult>): {
  runner: AuditRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const runner: AuditRunner = async (args, env, timeoutMs) => {
    const configFiles: Record<string, string | null> = {};
    for (const arg of args) {
      const match = /^--(userconfig|globalconfig)=(.+)$/.exec(arg);
      if (match) {
        configFiles[match[1]] = readConfigFile(match[2]);
      }
    }

    const call: RecordedCall = { args, env, timeoutMs, configFiles };
    calls.push(call);
    const override = respond(call, calls.length - 1);

    const merged: RunnerResult = {
      status: 1,
      signal: null,
      error: null,
      stdout: '',
      timedOut: false,
      overflow: false,
      limitBytes: NPM_MAX_OUTPUT_BYTES,
      outputBytes: 0,
      ...override,
    };

    return { ...merged, outputBytes: Buffer.byteLength(merged.stdout, 'utf8') };
  };

  return { runner, calls };
}

/** A runner that answers both calls with the same stdout, mimicking `npm audit --json`. */
export function fixturesRunner(
  fullStdout: string,
  productionStdout: string,
  overrides: Partial<RunnerResult> = {}
): { runner: AuditRunner; calls: RecordedCall[] } {
  return fakeRunner((_call, index) => ({
    stdout: index === 0 ? fullStdout : productionStdout,
    ...overrides,
  }));
}

/** A runner that fails the test if it is reached: preflight checks must stop before npm. */
export function forbiddenRunner(): AuditRunner {
  return async () => {
    throw new Error('npm must not be called');
  };
}
