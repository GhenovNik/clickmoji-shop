// Pruning policy: 7 daily, 4 weekly and 3 monthly copies, at most 14 in total.
// Tiers are applied newest first and never reuse a copy or a calendar day, so the
// tiers stay disjoint and the total is exact when the history is long enough.
import { RETENTION } from './constants.mjs';

const dayKey = (date) => date.toISOString().slice(0, 10);
const monthKey = (date) => date.toISOString().slice(0, 7);

// ISO week, keyed by its Monday.
function weekKey(date) {
  const offset = (date.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset)
  );
  return dayKey(monday);
}

// entries: [{ name, time: Date }]. Returns the names to keep and to remove.
export function selectRetention(entries, policy = RETENTION) {
  const newestFirst = [...entries].sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));
  const keep = new Set();
  const keptDays = new Set();
  const tiers = [
    [policy.daily, dayKey],
    [policy.weekly, weekKey],
    [policy.monthly, monthKey],
  ];
  for (const [limit, periodOf] of tiers) {
    const periods = new Set();
    for (const entry of newestFirst) {
      if (keep.has(entry.name)) continue;
      const day = dayKey(entry.time);
      if (keptDays.has(day)) continue;
      const period = periodOf(entry.time);
      if (periods.has(period) || periods.size >= limit) continue;
      periods.add(period);
      keep.add(entry.name);
      keptDays.add(day);
    }
  }
  return {
    keep: entries.map((entry) => entry.name).filter((name) => keep.has(name)),
    remove: entries.map((entry) => entry.name).filter((name) => !keep.has(name)),
  };
}
