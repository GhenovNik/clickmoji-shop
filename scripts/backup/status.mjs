// One tab-separated line per run, appended to the status file: date, outcome, detail.
// Only fixed texts, sizes, verdicts and the backup file name go in; never an address,
// a credential, a table name or a row count.
import { appendFileSync } from 'node:fs';

const SECRET_LIKE = /postgres(ql)?:\/\/|password|@|host\.docker\.internal/i;

export function formatStatusLine({ now, outcome, detail }) {
  if (SECRET_LIKE.test(detail)) throw new Error('status detail must not contain secrets');
  return `${now.toISOString()}\t${outcome}\t${detail}\n`;
}

export function appendStatus(statusFile, line) {
  appendFileSync(statusFile, line, { mode: 0o600 });
}
