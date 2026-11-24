// Recovery marker for containers. Every container name is written here, fsynced, before its
// `docker run` starts, and is removed only after the daemon has been seen to hold no container
// of that name. A run that is killed, or that cannot prove a container gone, leaves the name
// behind. Every later run takes the lock first and then must prove those containers gone before
// it does anything else: while the ledger is not empty, no run starts a container or publishes.
// A ledger that cannot be read is treated the same way (fail closed).
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

export class LedgerError extends Error {}

export class Ledger {
  #file;

  constructor(backupDir) {
    this.#file = path.join(backupDir, LEDGER_NAME);
  }

  // Names recorded and not yet proven gone. Throws LedgerError when the file is unreadable.
  list() {
    let text;
    try {
      text = readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new LedgerError('ledger unreadable');
    }
    let names;
    try {
      names = JSON.parse(text).containers;
    } catch {
      throw new LedgerError('ledger unreadable');
    }
    if (!Array.isArray(names) || !names.every((name) => CONTAINER_NAME.test(name))) {
      throw new LedgerError('ledger unreadable');
    }
    return names;
  }

  add(name) {
    if (!CONTAINER_NAME.test(name)) throw new LedgerError('container name not recordable');
    const names = this.list();
    if (!names.includes(name)) this.#write([...names, name]);
  }

  remove(name) {
    this.#write(this.list().filter((entry) => entry !== name));
  }

  // Writes the whole list durably: a temporary file is fsynced, then renamed over the ledger.
  // An empty list removes the file.
  #write(names) {
    if (names.length === 0) {
      rmSync(this.#file, { force: true });
      return;
    }
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify({ containers: names }), { mode: 0o600 });
    const fd = openSync(temp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.#file);
  }
}
