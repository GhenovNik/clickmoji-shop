// Child process for lock.test.mjs. Makes one attempt at the lock and reports it on stdout as
// one JSON line. An acquiring worker holds the lock until the gate file exists, then releases
// it and reports whether the record was still its own.
import { existsSync } from 'node:fs';
import { acquireLock } from '../lock.mjs';

const [, , backupDir, gate] = process.argv;
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const lock = acquireLock(backupDir);
if (!lock) {
  report({ pid: process.pid, acquired: false });
  process.exit(0);
}
report({ pid: process.pid, acquired: true });
const deadline = Date.now() + 30_000;
while (!existsSync(gate) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
report({ pid: process.pid, stillHeld: lock.held() });
lock.release();
