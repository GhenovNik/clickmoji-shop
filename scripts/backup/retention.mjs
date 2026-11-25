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
//   remove all unencrypted copies and apply N-copy retention to the encrypted copies.
// - When encryption is on, unencrypted copies exist, and confirmed === false:
//   keep up to N newest unencrypted copies, plus the first encrypted copy of the current
//   transition (for operator restore testing) and the newest encrypted copy (just published),
//   pruning intermediate encrypted copies so space stays bounded to at most N + 2.
export function selectTransitionRetention({
  entries,
  keepCount = DEFAULT_RETENTION_COUNT,
  encrypt = false,
  confirmed = false,
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
    const { keep, remove: removeEncrypted } = selectRetention(encrypted, keepCount);
    const removeSet = new Set([...plain.map((entry) => entry.name), ...removeEncrypted]);
    return {
      keep,
      remove: entries.map((entry) => entry.name).filter((name) => removeSet.has(name)),
      waitingForConfirmation: false,
    };
  }

  const keptPlain = [...plain].sort(compareNewest).slice(0, keepCount);
  const latestPlain = keptPlain[0];
  const transitionEncrypted = encrypted
    .filter((entry) => compareOldest(entry, latestPlain) > 0)
    .sort(compareOldest);
  const keptEncrypted = [];
  if (transitionEncrypted.length === 1) {
    keptEncrypted.push(transitionEncrypted[0]);
  } else if (transitionEncrypted.length >= 2) {
    keptEncrypted.push(transitionEncrypted[0], transitionEncrypted.at(-1));
  } else if (encrypted.length > 0) {
    keptEncrypted.push([...encrypted].sort(compareNewest)[0]);
  }
  const keepSet = new Set([...keptPlain, ...keptEncrypted].map((entry) => entry.name));
  return {
    keep: entries.map((entry) => entry.name).filter((name) => keepSet.has(name)),
    remove: entries.map((entry) => entry.name).filter((name) => !keepSet.has(name)),
    waitingForConfirmation: true,
  };
}
