// One tab-separated line per run, appended to the status file: date, outcome, detail.
// Only fixed texts, sizes, verdicts and the backup file name go in; never an address,
// a credential, a table name or a row count.
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';

const SECRET_LIKE = /postgres(ql)?:\/\/|password|@|host\.docker\.internal/i;

export function formatStatusLine({ now, outcome, detail }) {
  if (SECRET_LIKE.test(detail)) throw new Error('status detail must not contain secrets');
  return `${now.toISOString()}\t${outcome}\t${detail}\n`;
}

// Opens without following a symlink and refuses a file with another name. Symlink and
// hard-link checks at configuration time are repeated here, because the file may change later.
export function appendStatus(statusFile, line) {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const fd = openSync(statusFile, flags, 0o600);
  try {
    if (fstatSync(fd).nlink > 1) throw new Error('status file has another name');
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}
