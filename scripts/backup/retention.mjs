// Pruning policy: keep the N newest successful copies (default 2), and preserve unencrypted
// copies across the encryption cutover until operator restore confirmation + next encrypted publish.
import { DEFAULT_RETENTION_COUNT } from './constants.mjs';

const compareOldest = (a, b) => a.time - b.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const compareNewest = (a, b) => -compareOldest(a, b);
const isEncryptedEntry = (entry) =>
  typeof entry.encrypted === 'boolean' ? entry.encrypted : entry.name.endsWith('.dump.age');

// entries: [{ name, time: Date }]. Returns the names to keep and to remove.
export function selectRetention(entries, keepCount = DEFAULT_RETENTION_COUNT) {
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw new Error('keepCount must be an integer >= 1');
  }
  const newestFirst = [...entries].sort(compareNewest);
  const keepSet = new Set(newestFirst.slice(0, keepCount).map((entry) => entry.name));
  return {
    keep: entries.map((entry) => entry.name).filter((name) => keepSet.has(name)),
    remove: entries.map((entry) => entry.name).filter((name) => !keepSet.has(name)),
  };
}

// Transition-aware retention for verified backups across .dump and .dump.age formats:
// - When encryption is off: unified N-copy retention across both formats.
// - When encryption is on and no unencrypted copies exist: unified N-copy retention.
// - When encryption is on, unencrypted copies exist, and confirmed === true:
//   keep the operator-confirmed encrypted copy plus up to N - 1 newest other encrypted copies
//   (at N = 1, the confirmed copy takes priority on this cutover run). Excess unencrypted
//   encrypted copies are removed first, then unencrypted copies oldest-to-newest.
// - When encryption is on, unencrypted copies exist, and confirmed === false:
//   keep up to N newest unencrypted copies and the first encrypted copy of the current
//   transition; other .age copies fill only free slots in the normal limit N, capping total
//   retained copies at max(N, plainKept + 1) (at most N + 1, never N + 2).
export function selectTransitionRetention({
  entries,
  keepCount = DEFAULT_RETENTION_COUNT,
  encrypt = false,
  confirmed = false,
  confirmedFile = null,
}) {
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw new Error('keepCount must be an integer >= 1');
  }
  if (!encrypt) {
    return {
      ...selectRetention(entries, keepCount),
      waitingForConfirmation: false,
    };
  }
  const plain = entries.filter((entry) => !isEncryptedEntry(entry));
  const encrypted = entries.filter((entry) => isEncryptedEntry(entry));
  if (plain.length === 0) {
    return {
      ...selectRetention(entries, keepCount),
      waitingForConfirmation: false,
    };
  }
  if (confirmed) {
    const confirmedEntry = confirmedFile
      ? encrypted.find((entry) => entry.name === confirmedFile)
      : null;
    if (!confirmedEntry) {
      throw new Error('confirmedFile must match an encrypted entry when confirmed is true');
    }
    const otherEncrypted = encrypted
      .filter((entry) => entry.name !== confirmedEntry.name)
      .sort(compareNewest);
    const keptEncrypted = [confirmedEntry, ...otherEncrypted.slice(0, keepCount - 1)];
    const keepSet = new Set(keptEncrypted.map((entry) => entry.name));
    // Prune excess/unconfirmed ciphertext first and open copies oldest-to-newest last so any
    // interruption point during cleanup preserves an available verified copy.
    const removeEncrypted = encrypted
      .filter((entry) => !keepSet.has(entry.name))
      .sort(compareOldest);
    const removePlain = [...plain].sort(compareOldest);
    return {
      keep: entries.map((entry) => entry.name).filter((name) => keepSet.has(name)),
      remove: [...removeEncrypted, ...removePlain].map((entry) => entry.name),
      waitingForConfirmation: false,
    };
  }

  const keptPlain = [...plain].sort(compareNewest).slice(0, keepCount);
  const latestPlain = keptPlain[0];
  const transitionEncrypted = encrypted
    .filter((entry) => compareOldest(entry, latestPlain) > 0)
    .sort(compareOldest);
  const firstEncrypted = transitionEncrypted[0] ?? null;
  const totalLimit = Math.max(keepCount, keptPlain.length + (firstEncrypted ? 1 : 0));
  const freeEncryptedSlots = Math.max(0, totalLimit - keptPlain.length - (firstEncrypted ? 1 : 0));
  const otherEncrypted = encrypted
    .filter((entry) => !firstEncrypted || entry.name !== firstEncrypted.name)
    .sort(compareNewest)
    .slice(0, freeEncryptedSlots);
  const keptEncrypted = firstEncrypted ? [firstEncrypted, ...otherEncrypted] : otherEncrypted;
  const keepSet = new Set([...keptPlain, ...keptEncrypted].map((entry) => entry.name));
  const removePlain = plain.filter((entry) => !keepSet.has(entry.name)).sort(compareOldest);
  const removeEncrypted = encrypted.filter((entry) => !keepSet.has(entry.name)).sort(compareOldest);
  return {
    keep: entries.map((entry) => entry.name).filter((name) => keepSet.has(name)),
    remove: [...removePlain, ...removeEncrypted].map((entry) => entry.name),
    waitingForConfirmation: true,
  };
}
