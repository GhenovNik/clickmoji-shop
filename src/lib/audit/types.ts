export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'] as const;

export type Severity = (typeof SEVERITIES)[number];

export type ReportLabel = 'full' | 'production';

export type AllowlistMaxSeverity = 'high' | 'critical';

export interface AuditAdvisory {
  readonly name: string;
  readonly severity: Severity;
  readonly source: string;
  readonly url: string | null;
}

export interface ReportNode {
  readonly key: string;
  readonly name: string;
  readonly severity: Severity;
  readonly via: readonly (string | AuditAdvisory)[];
}

export interface AuditReport {
  readonly label: ReportLabel;
  readonly vulnerabilities: ReadonlyMap<string, ReportNode>;
}

export interface AllowlistEntry {
  readonly id: string;
  readonly packages: readonly string[];
  readonly reason: string;
  readonly scope: 'dev';
  readonly maxSeverity: AllowlistMaxSeverity;
  readonly expires: string;
  readonly issue: string;
}

export interface Allowlist {
  readonly version: 1;
  readonly exceptions: readonly AllowlistEntry[];
}

export interface Failure {
  readonly field: string;
  readonly message: string;
}

export type ReportParseResult =
  | { readonly ok: true; readonly report: AuditReport }
  | { readonly ok: false; readonly failure: Failure };

export type AllowlistParseResult =
  | { readonly ok: true; readonly allowlist: Allowlist }
  | { readonly ok: false; readonly failure: Failure };

export interface Decision {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

export function isHighSeverity(value: Severity): boolean {
  return value === 'high' || value === 'critical';
}

export function severityRank(value: Severity): number {
  return SEVERITIES.indexOf(value);
}

export function reportName(label: ReportLabel): string {
  return label === 'full' ? 'full report' : 'production report';
}
