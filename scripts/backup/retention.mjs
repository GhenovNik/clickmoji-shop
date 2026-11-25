// Pruning policy: keep the N newest successful copies (default 2).
import { DEFAULT_RETENTION_COUNT } from './constants.mjs';

// entries: [{ name, time: Date }]. Returns the names to keep and to remove.
export function selectRetention(entries, keepCount = DEFAULT_RETENTION_COUNT) {
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw new Error('keepCount must be an integer >= 1');
  }
  const newestFirst = [...entries].sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));
  const keepSet = new Set(newestFirst.slice(0, keepCount).map((entry) => entry.name));
  return {
    keep: entries.map((entry) => entry.name).filter((name) => keepSet.has(name)),
    remove: entries.map((entry) => entry.name).filter((name) => !keepSet.has(name)),
  };
}
