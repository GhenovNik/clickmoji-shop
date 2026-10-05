import { isNonEmptyString, isPlainObject, printable } from './text';
import {
  isSeverity,
  type AuditAdvisory,
  type AuditReport,
  type Failure,
  type ReportLabel,
  type ReportNode,
  type ReportParseResult,
} from './types';

const SEVERITY_LIST = 'info, low, moderate, high, critical';

type ReportFailure = { readonly ok: false; readonly failure: Failure };

type AdvisoryResult = { readonly ok: true; readonly advisory: AuditAdvisory } | ReportFailure;

function invalid(field: string, message: string): ReportFailure {
  return { ok: false, failure: { field, message } };
}

function describeNpmError(value: unknown): string {
  if (!isPlainObject(value)) {
    return printable(value);
  }

  const code = printable(value.code, 80);
  const summary = printable(value.summary, 160);
  return `${code} ${summary}`.trim();
}

function parseAdvisory(value: Record<string, unknown>, path: string): AdvisoryResult {
  if (!isNonEmptyString(value.name)) {
    return invalid(`${path}.name`, `${path}.name must be a string`);
  }

  if (!isSeverity(value.severity)) {
    return invalid(`${path}.severity`, `${path}.severity must be one of ${SEVERITY_LIST}`);
  }

  return {
    ok: true,
    advisory: {
      name: value.name,
      severity: value.severity,
      source: printable(value.source, 60),
      url: typeof value.url === 'string' ? value.url : null,
    },
  };
}

export function parseReport(label: ReportLabel, stdout: string): ReportParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return invalid('stdout', 'stdout is not valid JSON');
  }

  if (!isPlainObject(parsed)) {
    return invalid('root', 'report root must be a JSON object');
  }

  if ('error' in parsed) {
    return invalid('error', `report carries an npm error field: ${describeNpmError(parsed.error)}`);
  }

  if (parsed.auditReportVersion !== 2) {
    return invalid(
      'auditReportVersion',
      `auditReportVersion must be 2, got ${printable(parsed.auditReportVersion)}`
    );
  }

  if (!isPlainObject(parsed.vulnerabilities)) {
    return invalid('vulnerabilities', 'vulnerabilities must be a JSON object');
  }

  const vulnerabilities: Record<string, ReportNode> = {};

  for (const [key, value] of Object.entries(parsed.vulnerabilities)) {
    const path = `vulnerabilities.${key}`;

    if (!isPlainObject(value)) {
      return invalid(path, `${path} must be a JSON object`);
    }

    if (typeof value.name !== 'string') {
      return invalid(`${path}.name`, `${path}.name must be a string`);
    }

    if (!isSeverity(value.severity)) {
      return invalid(`${path}.severity`, `${path}.severity must be one of ${SEVERITY_LIST}`);
    }

    if (!Array.isArray(value.via) || value.via.length === 0) {
      return invalid(`${path}.via`, `${path}.via must be a non-empty array`);
    }

    const via: (string | AuditAdvisory)[] = [];

    for (const [index, item] of value.via.entries()) {
      const itemPath = `${path}.via[${index}]`;

      if (typeof item === 'string') {
        via.push(item);
        continue;
      }

      if (!isPlainObject(item)) {
        return invalid(itemPath, `${itemPath} must be a string or an advisory object`);
      }

      const parsedAdvisory = parseAdvisory(item, itemPath);
      if (!parsedAdvisory.ok) {
        return parsedAdvisory;
      }
      via.push(parsedAdvisory.advisory);
    }

    vulnerabilities[key] = {
      key,
      name: value.name,
      severity: value.severity,
      via,
    };
  }

  return { ok: true, report: { label, vulnerabilities } };
}
