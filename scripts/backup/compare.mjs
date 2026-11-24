// Parsing and comparison of the describe reports written by container/verify.sh.
// Any malformed line throws: an unreadable report is a failed verification, never "empty".
import { DROP_THRESHOLD_PERCENT } from './constants.mjs';

export class ReportError extends Error {}

export function parseIdentities(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ReportError('identities: bad line');
    if (map.has(parts[0])) throw new ReportError('identities: duplicate table');
    map.set(parts[0], parts[1]);
  }
  if (map.size === 0) throw new ReportError('identities: no tables');
  return map;
}

export function parseMigration(text) {
  const name = text.trim();
  if (!name || name.includes('\t') || name.includes('\n'))
    throw new ReportError('migration: bad value');
  return name;
}

export function parseCounts(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length !== 2 || !parts[0]) throw new ReportError('counts: bad line');
    if (!/^\d+$/.test(parts[1])) throw new ReportError('counts: not a number');
    map.set(parts[0], Number(parts[1]));
  }
  return map;
}

// Returns the list of differences; an empty list means the identities match.
export function compareIdentities(source, restored) {
  const problems = [];
  for (const table of source.keys()) {
    if (!restored.has(table)) problems.push(`missing:${table}`);
    else if (restored.get(table) !== source.get(table)) problems.push(`changed:${table}`);
  }
  for (const table of restored.keys()) {
    if (!source.has(table)) problems.push(`extra:${table}`);
  }
  return problems;
}

// Tables whose count fell by more than the threshold against the previous good copy.
export function findDrops(previous, current, percent = DROP_THRESHOLD_PERCENT) {
  const drops = [];
  for (const [table, before] of previous) {
    if (before <= 0) continue;
    const after = current.get(table) ?? 0;
    if (after * 100 < before * (100 - percent)) drops.push({ table, before, after });
  }
  return drops;
}
