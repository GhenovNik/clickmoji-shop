import { isNonEmptyString, isPlainObject, printable } from './text';
import type {
  Allowlist,
  AllowlistEntry,
  AllowlistMaxSeverity,
  AllowlistParseResult,
  Failure,
} from './types';

const GHSA_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const ISSUE_ID = /^AGE-[0-9]+$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ROOT_FIELDS = ['version', 'exceptions'] as const;
const ENTRY_FIELDS = [
  'id',
  'packages',
  'reason',
  'scope',
  'maxSeverity',
  'expires',
  'issue',
] as const;
const MAX_SEVERITIES: readonly string[] = ['high', 'critical'];

export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function expiryInstant(expires: string): number {
  return Date.parse(`${expires}T23:59:59.999Z`);
}

export function isEntryExpired(entry: AllowlistEntry, now: Date): boolean {
  return now.getTime() > expiryInstant(entry.expires);
}

export function findExpiredEntry(
  allowlist: Allowlist,
  now: Date
): { readonly index: number; readonly entry: AllowlistEntry } | null {
  for (const [index, entry] of allowlist.exceptions.entries()) {
    if (isEntryExpired(entry, now)) {
      return { index, entry };
    }
  }

  return null;
}

type AllowlistFailure = { readonly ok: false; readonly failure: Failure };

function invalid(field: string, message: string): AllowlistFailure {
  return { ok: false, failure: { field, message } };
}

type PackagesResult =
  { readonly ok: true; readonly packages: readonly string[] } | AllowlistFailure;

function parsePackages(value: unknown, path: string): PackagesResult {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid(`${path}.packages`, `${path}.packages must be a non-empty array of strings`);
  }

  for (const [index, item] of value.entries()) {
    if (!isNonEmptyString(item)) {
      return invalid(
        `${path}.packages[${index}]`,
        `${path}.packages[${index}] must be a non-empty string`
      );
    }
  }

  if (new Set(value as string[]).size !== value.length) {
    return invalid(`${path}.packages`, `${path}.packages must not contain duplicates`);
  }

  return { ok: true, packages: value as readonly string[] };
}

export function parseAllowlist(raw: string): AllowlistParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('audit-allowlist.json', 'audit-allowlist.json: file is not valid JSON');
  }

  if (!isPlainObject(parsed)) {
    return invalid(
      'audit-allowlist.json',
      'audit-allowlist.json: root must be a JSON object with version and exceptions'
    );
  }

  for (const key of Object.keys(parsed)) {
    if (!(ROOT_FIELDS as readonly string[]).includes(key)) {
      return invalid('audit-allowlist.json', `audit-allowlist.json: unknown field "${key}"`);
    }
  }

  if (parsed.version !== 1) {
    return invalid('audit-allowlist.json', 'audit-allowlist.json: version must be 1');
  }

  if (!Array.isArray(parsed.exceptions)) {
    return invalid('audit-allowlist.json', 'audit-allowlist.json: exceptions must be an array');
  }

  const exceptions: AllowlistEntry[] = [];
  const seenIds = new Set<string>();

  for (const [index, value] of parsed.exceptions.entries()) {
    const path = `exceptions[${index}]`;

    if (!isPlainObject(value)) {
      return invalid(path, `${path} must be a JSON object`);
    }

    for (const key of Object.keys(value)) {
      if (!(ENTRY_FIELDS as readonly string[]).includes(key)) {
        return invalid(`${path}.${key}`, `${path}.${key}: unknown field "${key}"`);
      }
    }

    for (const field of ENTRY_FIELDS) {
      if (!(field in value)) {
        return invalid(`${path}.${field}`, `${path}.${field} is required`);
      }
    }

    if (!isNonEmptyString(value.id)) {
      return invalid(`${path}.id`, `${path}.id must be a non-empty string`);
    }

    if (!GHSA_ID.test(value.id)) {
      return invalid(
        `${path}.id`,
        `${path}.id must match ${GHSA_ID.source}, got "${printable(value.id)}"`
      );
    }

    if (seenIds.has(value.id)) {
      return invalid(`${path}.id`, `${path}.id: duplicate id ${value.id}`);
    }

    const packages = parsePackages(value.packages, path);
    if (!packages.ok) {
      return packages;
    }

    if (!isNonEmptyString(value.reason)) {
      return invalid(`${path}.reason`, `${path}.reason must be a non-empty string`);
    }

    if (value.scope !== 'dev') {
      return invalid(`${path}.scope`, `${path}.scope must be "dev"`);
    }

    if (!isNonEmptyString(value.maxSeverity) || !MAX_SEVERITIES.includes(value.maxSeverity)) {
      return invalid(
        `${path}.maxSeverity`,
        `${path}.maxSeverity must be "high" or "critical", got ${printable(value.maxSeverity)}`
      );
    }

    if (!isNonEmptyString(value.expires) || !isCalendarDate(value.expires)) {
      return invalid(
        `${path}.expires`,
        `${path}.expires must be an existing calendar date (YYYY-MM-DD), got ${printable(value.expires)}`
      );
    }

    if (!isNonEmptyString(value.issue)) {
      return invalid(`${path}.issue`, `${path}.issue must be a non-empty string`);
    }

    if (!ISSUE_ID.test(value.issue)) {
      return invalid(
        `${path}.issue`,
        `${path}.issue must match ${ISSUE_ID.source}, got "${printable(value.issue)}"`
      );
    }

    seenIds.add(value.id);
    exceptions.push({
      id: value.id,
      packages: packages.packages,
      reason: value.reason,
      scope: 'dev',
      maxSeverity: value.maxSeverity as AllowlistMaxSeverity,
      expires: value.expires,
      issue: value.issue,
    });
  }

  return { ok: true, allowlist: { version: 1, exceptions } };
}
