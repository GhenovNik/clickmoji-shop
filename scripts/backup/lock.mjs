// One backup at a time per backup directory, enforced by the operating system.
//
// The lock is an exclusive flock(2) on a stable file, `.backup.lock`. That file is created once
// and never renamed, replaced or removed. The kernel releases the lock when every open file
// description of it is closed: the holder's exit, including SIGKILL, closes them all.
//
// The lock is taken by a launcher, the macOS system perl (/usr/bin/perl, present on every
// supported host). It opens the lock file without following links, takes the flock without
// blocking, clears FD_CLOEXEC on that descriptor, checks the flags, and then exec()s the writer
// in the same process. The writer therefore inherits the locked descriptor and owns it for its
// whole critical section; no helper process and no control protocol sit beside it. There is
// nothing to ping: while the writer lives, the descriptor is open and the lock is held; when the
// writer dies, the kernel closes the descriptor and frees the lock.
//
// The launcher passes the descriptor number in BACKUP_LOCK_FD. The writer checks with heldLock()
// that this descriptor refers to the lock file. BACKUP_LOCK_FD is set only by the launcher.
//
// Child processes do not receive the descriptor: libuv starts them with only their stdio, so a
// docker client cannot keep the lock alive after the writer has gone (checked by a test).
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { LOCK_NAME } from './constants.mjs';

const PERL = '/usr/bin/perl';

export const LOCK_FD_ENV = 'BACKUP_LOCK_FD';
// Launcher exit statuses. A writer never exits with either of them.
export const LAUNCH_BUSY = 75; // another process holds the lock
export const LAUNCH_FAILED = 70; // the lock could not be taken or the writer could not start

// The launcher. Exits LAUNCH_BUSY when the lock is held elsewhere, LAUNCH_FAILED when anything
// it relies on cannot be verified; otherwise the exec replaces it with the writer.
const LAUNCHER = `
use strict;
use warnings;
use Fcntl qw(:flock O_RDWR O_CREAT O_NOFOLLOW F_GETFD F_SETFD FD_CLOEXEC);
my ($path, @command) = @ARGV;
sysopen(my $fh, $path, O_RDWR | O_CREAT | O_NOFOLLOW, 0600) or exit ${LAUNCH_FAILED};
my @named = lstat($path) or exit ${LAUNCH_FAILED};
my @opened = stat($fh) or exit ${LAUNCH_FAILED};
exit ${LAUNCH_FAILED} unless $named[0] == $opened[0] && $named[1] == $opened[1];
flock($fh, LOCK_EX | LOCK_NB) or exit ${LAUNCH_BUSY};
fcntl($fh, F_SETFD, 0) or exit ${LAUNCH_FAILED};
my $flags = fcntl($fh, F_GETFD, 0);
exit ${LAUNCH_FAILED} if !defined $flags || ($flags & FD_CLOEXEC);
$ENV{'${LOCK_FD_ENV}'} = fileno($fh);
exec { $command[0] } @command or exit ${LAUNCH_FAILED};
`;

// True when a process with this pid exists (EPERM means it exists under another user).
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Starts `command` as the writer of backupDir's lock. The returned child is the writer itself
// (the launcher execs it, so the PID is the same) and holds the lock while it lives. Resolves
// its exit through `child.on('exit')`: LAUNCH_BUSY or LAUNCH_FAILED mean it never ran.
export function launchLocked(backupDir, command, { env = process.env, stdio = 'inherit' } = {}) {
  // The lock file lives in the backup directory, which is created private, as the run would.
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const childEnv = { ...env };
  delete childEnv[LOCK_FD_ENV];
  return spawn(PERL, ['-e', LAUNCHER, path.join(backupDir, LOCK_NAME), ...command], {
    env: childEnv,
    stdio,
  });
}

// The lock held by this process, or null. Null means the descriptor is missing or does not
// refer to the lock file: the caller must not write anything.
export function heldLock(backupDir, env = process.env) {
  const raw = env[LOCK_FD_ENV];
  if (!/^[0-9]+$/.test(raw ?? '')) return null;
  const fd = Number(raw);
  if (fd < 3) return null;
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(path.join(backupDir, LOCK_NAME));
    if (opened.dev !== named.dev || opened.ino !== named.ino) return null;
  } catch {
    return null;
  }
  return new Lock(fd);
}

// The writer's hold on the lock. The descriptor is open for as long as the lock is held, so
// held() needs no round trip. release() closes the descriptor, which frees the kernel lock.
export class Lock {
  #fd;
  #released = false;

  constructor(fd) {
    this.#fd = fd;
  }

  held() {
    return !this.#released;
  }

  release() {
    if (this.#released) return;
    this.#released = true;
    try {
      closeSync(this.#fd);
    } catch {
      // Already closed: the kernel lock is gone either way.
    }
  }
}
