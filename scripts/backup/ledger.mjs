// Recovery marker for containers. Every container name is written here, fsynced, before its
// `create` is sent, and is removed only once the daemon has been seen to hold no container of that
// name, and only from a state that makes that answer final (see STATES in docker.mjs). A run that
// is killed, or that cannot prove a container gone, leaves the name behind. Every later run takes
// the lock first and then must reconcile those names before it does anything else: while the ledger
// is not empty, no run starts a container or publishes. A ledger that cannot be read is treated the
// same way (fail closed).
//
// On disk: { "containers": [name, ...], "states": { name: state } }. A name without a state is
// `pending`: the conservative reading, which is also what an older ledger (names only) gives.
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { LEDGER_NAME } from './constants.mjs';

const CONTAINER_NAME = /^clickmoji-backup-[a-z]+-[0-9a-f]{12}$/;
const STATES = new Set(['pending', 'settled', 'exists']);

export class LedgerError extends Error {}

export class Ledger {
  #file;

  constructor(backupDir) {
    this.#file = path.join(backupDir, LEDGER_NAME);
  }

  // Entries recorded and not yet cleared: [{ name, state }]. Throws LedgerError when unreadable.
  entries() {
    let text;
    try {
      text = readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new LedgerError('ledger unreadable');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LedgerError('ledger unreadable');
    }
    const names = parsed?.containers;
    const states = parsed?.states ?? {};
    if (!Array.isArray(names) || !names.every((name) => CONTAINER_NAME.test(name))) {
      throw new LedgerError('ledger unreadable');
    }
    if (typeof states !== 'object' || states === null || Array.isArray(states)) {
      throw new LedgerError('ledger unreadable');
    }
    return names.map((name) => {
      const state = states[name] ?? 'pending';
      if (!STATES.has(state)) throw new LedgerError('ledger unreadable');
      return { name, state };
    });
  }

  // Names recorded and not yet cleared.
  list() {
    return this.entries().map((entry) => entry.name);
  }

  // Records a name as pending, unless it is already recorded.
  add(name) {
    if (!CONTAINER_NAME.test(name)) throw new LedgerError('container name not recordable');
    const entries = this.entries();
    if (entries.some((entry) => entry.name === name)) return;
    this.#write([...entries, { name, state: 'pending' }]);
  }

  setState(name, state) {
    if (!STATES.has(state)) throw new LedgerError('state not recordable');
    const entries = this.entries();
    if (!entries.some((entry) => entry.name === name)) throw new LedgerError('name not recorded');
    this.#write(entries.map((entry) => (entry.name === name ? { name, state } : entry)));
  }

  remove(name) {
    this.#write(this.entries().filter((entry) => entry.name !== name));
  }

  // Writes the whole list durably: a temporary file is fsynced, then renamed over the ledger.
  // An empty list removes the file.
  #write(entries) {
    if (entries.length === 0) {
      rmSync(this.#file, { force: true });
      return;
    }
    const body = {
      containers: entries.map((entry) => entry.name),
      states: Object.fromEntries(entries.map((entry) => [entry.name, entry.state])),
    };
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify(body), { mode: 0o600 });
    const fd = openSync(temp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.#file);
  }
}
