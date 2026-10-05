import { findExpiredEntry } from './allowlist';
import { printable } from './text';
import {
  isHighSeverity,
  severityRank,
  type Allowlist,
  type AllowlistEntry,
  type AuditAdvisory,
  type AuditReport,
  type Decision,
  type ReportNode,
  type Severity,
} from './types';

const GHSA_ADVISORY_URL =
  /^https:\/\/github\.com\/advisories\/(GHSA(-[23456789cfghjmpqrvwx]{4}){3})$/;
const PRODUCTION_GATE_REASON =
  'production gate: high and critical advisories are never allowed in production dependencies';

export interface DecideInput {
  readonly full: AuditReport;
  readonly production: AuditReport;
  readonly allowlist: Allowlist;
  readonly now: Date;
}

export function advisoryIdFromUrl(url: string | null): string | null {
  if (url === null) {
    return null;
  }

  const match = GHSA_ADVISORY_URL.exec(url);
  return match === null ? null : match[1];
}

function errorLine(errorClass: string, message: string): string {
  return `audit-check: error [${errorClass}]: ${message}`;
}

/** Every field the decision reads, so a repeated key can only be the very same object. */
function advisoryKey(item: AuditAdvisory): string {
  return `${item.url ?? ''}|${item.name}|${item.source}|${item.severity}`;
}

function blockingLine(
  name: string,
  severity: Severity,
  advisory: AuditAdvisory | null,
  reason: string
): string {
  const source = advisory === null ? 'n/a' : advisory.source;
  const url = advisory === null || advisory.url === null ? 'n/a' : printable(advisory.url);
  return `audit-check: blocking vulnerability: package ${printable(name)} (severity ${severity}, source ${source}, url ${url}) - ${reason}`;
}

function allowedLine(id: string, entry: AllowlistEntry, advisory: AuditAdvisory): string {
  const packages = printable(entry.packages.join(', '));
  return `audit-check: allowed advisory ${id} for package ${printable(advisory.name)} (severity ${advisory.severity}, scope dev, expires ${entry.expires}, issue ${entry.issue}, packages: ${packages}, reason: ${printable(entry.reason)})`;
}

interface Traversal {
  readonly severities: Severity[];
  readonly missingNode: string | null;
}

function reachableAdvisories(report: AuditReport, startKey: string): Traversal {
  const severities: Severity[] = [];
  const visited = new Set<string>([startKey]);
  const queue: string[] = [startKey];
  let missingNode: string | null = null;

  while (queue.length > 0) {
    const key = queue.shift() as string;
    const node = report.vulnerabilities.get(key);

    if (node === undefined) {
      missingNode = missingNode ?? key;
      continue;
    }

    for (const item of node.via) {
      if (typeof item === 'string') {
        if (!visited.has(item)) {
          visited.add(item);
          queue.push(item);
        }
        continue;
      }
      severities.push(item.severity);
    }
  }

  return { severities, missingNode };
}

function checkChain(report: AuditReport, node: ReportNode, findings: string[]): void {
  const { severities, missingNode } = reachableAdvisories(report, node.key);

  if (missingNode !== null) {
    findings.push(
      blockingLine(
        node.name,
        node.severity,
        null,
        `unresolvable chain: via entry references missing node ${printable(missingNode)}`
      )
    );
    return;
  }

  if (severities.length === 0) {
    if (isHighSeverity(node.severity)) {
      findings.push(
        blockingLine(
          node.name,
          node.severity,
          null,
          'unresolvable chain: node does not reach any advisory object'
        )
      );
    }
    return;
  }

  const highest = severities.reduce((left, right) =>
    severityRank(right) > severityRank(left) ? right : left
  );

  if (severityRank(node.severity) > severityRank(highest)) {
    findings.push(
      blockingLine(
        node.name,
        node.severity,
        null,
        `chain consistency: declared severity ${node.severity} is above the highest reachable advisory severity ${highest}`
      )
    );
  }
}

export function decideAudit(input: DecideInput): Decision {
  const { full, production, allowlist, now } = input;

  const expired = findExpiredEntry(allowlist, now);
  if (expired !== null) {
    return {
      exitCode: 1,
      lines: [
        errorLine(
          'schema',
          `audit-allowlist.json - exceptions[${expired.index}].expires ${expired.entry.expires} is in the past (now ${now.toISOString()})`
        ),
      ],
    };
  }

  const findings: string[] = [];
  const allowedLines: string[] = [];
  const entriesById = new Map(allowlist.exceptions.map((entry) => [entry.id, entry]));
  const seenAdvisories = new Set<string>();
  const allowedKeys = new Set<string>();
  const presentIds = new Set<string>();

  for (const node of production.vulnerabilities.values()) {
    if (isHighSeverity(node.severity)) {
      findings.push(blockingLine(node.name, node.severity, null, PRODUCTION_GATE_REASON));
    }
    for (const item of node.via) {
      if (typeof item !== 'string' && isHighSeverity(item.severity)) {
        findings.push(blockingLine(node.name, item.severity, item, PRODUCTION_GATE_REASON));
      }
    }
  }

  for (const node of full.vulnerabilities.values()) {
    for (const item of node.via) {
      if (typeof item === 'string') {
        continue;
      }

      const key = advisoryKey(item);
      if (seenAdvisories.has(key)) {
        continue;
      }
      seenAdvisories.add(key);

      const id = advisoryIdFromUrl(item.url);
      if (id === null) {
        if (isHighSeverity(item.severity)) {
          findings.push(
            blockingLine(
              item.name,
              item.severity,
              item,
              'advisory url is not a GitHub Security Advisory URL'
            )
          );
        }
        continue;
      }

      presentIds.add(id);

      if (!isHighSeverity(item.severity)) {
        continue;
      }

      const entry = entriesById.get(id);
      if (entry === undefined) {
        findings.push(blockingLine(item.name, item.severity, item, `no allowlist entry for ${id}`));
        continue;
      }

      if (!entry.packages.includes(item.name)) {
        findings.push(
          blockingLine(
            item.name,
            item.severity,
            item,
            `allowlist entry ${id} does not list package ${printable(item.name)}`
          )
        );
        continue;
      }

      if (severityRank(item.severity) > severityRank(entry.maxSeverity)) {
        findings.push(
          blockingLine(
            item.name,
            item.severity,
            item,
            `advisory severity ${item.severity} is above maxSeverity ${entry.maxSeverity} of ${id}`
          )
        );
        continue;
      }

      const allowedKey = `${id}|${item.name}`;
      if (!allowedKeys.has(allowedKey)) {
        allowedKeys.add(allowedKey);
        allowedLines.push(allowedLine(id, entry, item));
      }
    }
  }

  for (const node of full.vulnerabilities.values()) {
    checkChain(full, node, findings);
  }

  for (const node of production.vulnerabilities.values()) {
    checkChain(production, node, findings);
  }

  const warningLines = allowlist.exceptions
    .filter((entry) => !presentIds.has(entry.id))
    .map(
      (entry) =>
        `audit-check: warning: allowlist entry ${entry.id} (issue ${entry.issue}) is not present in the full report`
    );

  if (findings.length > 0) {
    return {
      exitCode: 1,
      lines: [
        ...allowedLines,
        ...findings,
        errorLine('vulnerability', `${findings.length} blocking finding(s)`),
        ...warningLines,
      ],
    };
  }

  return {
    exitCode: 0,
    lines: [
      ...allowedLines,
      ...warningLines,
      `audit-check: ok: ${allowedLines.length} allowed advisory, 0 blocking findings, ${warningLines.length} unused exception(s)`,
    ],
  };
}
