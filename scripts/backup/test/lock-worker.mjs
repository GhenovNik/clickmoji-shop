// Child process for the lock tests. Takes the real backup lock, reports the attempt as one JSON
// line on stdout, then holds the lock until the gate file exists or the process is killed. When
// the gate opens it reports whether it still holds the lock, confirms it, and releases.
import { existsSync } from 'node:fs';
import { acquireLock } from '../lock.mjs';

const [, , backupDir, gate] = process.argv;
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const lock = await acquireLock(backupDir);
if (!lock) {
  report({ pid: process.pid, acquired: false });
  process.exit(0);
}
report({ pid: process.pid, acquired: true, helperPid: lock.helperPid });
while (!existsSync(gate)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
report({ pid: process.pid, stillHeld: lock.held(), confirmed: await lock.confirm() });
await lock.release();
process.exit(0);
