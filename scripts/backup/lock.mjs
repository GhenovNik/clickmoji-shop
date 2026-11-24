// One backup at a time per backup directory, enforced by the operating system.
//
// The lock is an exclusive flock(2) on a stable file, `.backup.lock`. That file is created once
// and never renamed, replaced or removed, so there is no name that two processes can judge
// differently. Nothing is read from the file to decide ownership: a stale pid, an old record or
// an inode comparison cannot take a live owner's lock, because the kernel does not care about
// any of them. The lock is released by the kernel when its holder exits, including on SIGKILL.
//
// Node has no flock binding, so the lock is held by a tiny helper process: the macOS system
// perl (/usr/bin/perl, present on every supported host, nothing is installed). The helper takes
// the flock, reports `locked`, and then serves a control pipe:
//   ping     -> alive     (the helper is running and still holds the lock)
//   release  -> released  (unlock, then exit)
// End of the pipe (the parent exited, or crashed) makes the helper exit, and the exit releases
// the lock. The owner therefore never releases the lock by itself: release() ends the pipe only
// after the caller's critical work is finished, and resolves only once the helper has exited.
//
// Fail closed: if the helper dies while its owner runs, the owner loses the lock. held() and
// confirm() then say so, and the owner's onLost callbacks run, so it stops before it writes.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { LOCK_NAME } from './constants.mjs';

const PERL = '/usr/bin/perl';

// The helper. Opens the lock file without following links and without truncating it.
const HOLDER = `
use strict;
use warnings;
use Fcntl qw(:flock O_RDWR O_CREAT O_NOFOLLOW);
$| = 1;
my ($path) = @ARGV;
sysopen(my $fh, $path, O_RDWR | O_CREAT | O_NOFOLLOW, 0600) or do { print "error\\n"; exit 0 };
if (!flock($fh, LOCK_EX | LOCK_NB)) { print "busy\\n"; exit 0 }
print "locked\\n";
while (defined(my $line = <STDIN>)) {
  if ($line eq "ping\\n") { print "alive\\n"; next }
  if ($line eq "release\\n") { flock($fh, LOCK_UN); print "released\\n"; exit 0 }
}
exit 0;
`;

// Lines of a stream, delivered one at a time; null once the stream has closed.
function lineQueue(stream) {
  const lines = [];
  const waiters = [];
  let buffer = '';
  let closed = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf('\n');
    while (at !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (waiters.length > 0) waiters.shift()(line);
      else lines.push(line);
      at = buffer.indexOf('\n');
    }
  });
  stream.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()(null);
  });
  stream.on('error', () => {});
  return () => {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };
}

// True when a process with this pid exists (EPERM means it exists under another user).
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export class Lock {
  #child;
  #nextLine;
  #exited;
  #released = false;
  #lost = false;
  #lostCallbacks = [];

  constructor(child, nextLine) {
    this.#child = child;
    this.#nextLine = nextLine;
    this.#exited = new Promise((resolve) => {
      child.once('exit', () => {
        resolve();
        if (this.#released || this.#lost) return;
        this.#lost = true;
        for (const callback of this.#lostCallbacks.splice(0)) callback();
      });
    });
    child.stdin.on('error', () => {}); // a helper that already died is handled by its exit
  }

  get helperPid() {
    return this.#child.pid;
  }

  // Synchronous: false once released, or once the helper is known to have exited.
  held() {
    return !this.#released && !this.#lost;
  }

  // Asks the helper, which holds the lock, to confirm it is still alive. Use right before a
  // critical step. False means the lock can no longer be relied on.
  async confirm() {
    if (!this.held()) return false;
    this.#child.stdin.write('ping\n');
    return (await this.#nextLine()) === 'alive' && this.held();
  }

  // Registers a callback for the moment the lock is lost without release().
  onLost(callback) {
    if (this.#lost) callback();
    else if (!this.#released) this.#lostCallbacks.push(callback);
  }

  // Unlocks and resolves once the helper has exited, so the lock is free for the next process.
  async release() {
    if (this.#released) return this.#exited;
    this.#released = true;
    if (!this.#lost) {
      this.#child.stdin.write('release\n');
      this.#child.stdin.end();
    }
    await this.#exited;
  }
}

// Takes the lock for backupDir, or returns null when another live process holds it. Throws
// when the helper cannot run at all; the caller reports that as busy.
export async function acquireLock(backupDir) {
  const file = path.join(backupDir, LOCK_NAME);
  const child = spawn(PERL, ['-e', HOLDER, file], { stdio: ['pipe', 'pipe', 'ignore'] });
  const nextLine = lineQueue(child.stdout);
  const first = await Promise.race([
    nextLine(),
    new Promise((resolve) => child.once('exit', () => resolve(null))),
  ]);
  if (first === 'locked') return new Lock(child, nextLine);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (first === 'busy') return null;
  throw new Error('lock helper failed');
}
