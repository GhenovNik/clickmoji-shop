// docker CLI wrapper. Argument builders are pure so tests can read exactly what runs.
// The source connection travels only in the environment: every `-e NAME` below forwards a
// variable by name (DATABASE_URL and the libpq variables derived from it), so no argv
// (host or container) contains the address, host, user or password. Inside the containers
// the tools read the libpq variables themselves.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCKER_TIMEOUT_MS, TEMP_MARKER, TOOLS_IMAGE } from './constants.mjs';
import { LIBPQ_ENV_NAMES } from './config.mjs';

export const CONTAINER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'container'
);

export class Interrupted extends Error {}

// How long a docker client may take to close after a stop step before the next step runs.
export const STOP_GRACE_MS = 5000;
// After a timed-out client is killed, how long we wait for it to be reaped before giving up on it.
const REAP_MS = 5000;

const mount = (source, target, readonly = false) =>
  `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;

// ['-e', 'PGHOST', '-e', 'PGPORT', ...]: names only, every time, so the forwarded set is fixed.
const forwardLibpq = () => LIBPQ_ENV_NAMES.flatMap((name) => ['-e', name]);

// Source steps (dump, verify) get DATABASE_URL by name, then the libpq names.
// Names only: the value stays in the client environment.
const SOURCE_ENV_NAMES = Object.freeze(['DATABASE_URL', ...LIBPQ_ENV_NAMES]);
const forwardSource = () => SOURCE_ENV_NAMES.flatMap((name) => ['-e', name]);

// Every container of this tool runs with the daemon's log driver disabled. Otherwise the
// daemon keeps whatever a failing step prints (connection context, plaintext paths) in its own
// stdout/stderr log, outside this process, where no cleanup can reach it.
const QUIET = () => ['--log-driver', 'none'];

export const versionArgs = () => ['version', '--format', '{{.Server.Version}}'];
export const inspectImageArgs = () => ['image', 'inspect', TOOLS_IMAGE];
export const buildImageArgs = () => [
  'build',
  '-q',
  '-t',
  TOOLS_IMAGE,
  '-f',
  path.join(CONTAINER_DIR, 'Dockerfile.tools'),
  CONTAINER_DIR,
];

// Names of containers, all states, matching exactly `name`. Empty output means no container.
export const listNamedArgs = (name) => [
  'ps',
  '-a',
  '--filter',
  `name=^${name}$`,
  '--format',
  '{{.Names}}',
];
export const removeArgs = (name) => ['rm', '-f', name];
// The container is created first (`create`, bounded) and only then started (`start -a`, which
// runs for as long as the step takes). Splitting the two gives a point at which the daemon is
// known to hold the container: once `create` has exited 0.
export const startArgs = (name) => ['start', '-a', name];

export function dumpArgs({ name, workDir }) {
  return [
    'create',
    '--rm',
    '--name',
    name,
    ...QUIET(),
    ...forwardSource(),
    '--mount',
    mount(workDir, '/work'),
    '--mount',
    mount(CONTAINER_DIR, '/opt/backup', true),
    '--entrypoint',
    '/bin/sh',
    TOOLS_IMAGE,
    '/opt/backup/dump.sh',
  ];
}

export function verifyArgs({ name, workDir }) {
  return [
    'create',
    '--rm',
    '--name',
    name,
    ...QUIET(),
    ...forwardSource(),
    '--mount',
    mount(workDir, '/work'),
    '--mount',
    mount(CONTAINER_DIR, '/opt/backup', true),
    '--entrypoint',
    '/bin/sh',
    TOOLS_IMAGE,
    '/opt/backup/verify.sh',
  ];
}

export function encryptArgs({ name, workDir, recipientFile }) {
  return [
    'create',
    '--rm',
    '--name',
    name,
    ...QUIET(),
    '--mount',
    mount(workDir, '/work'),
    '--mount',
    mount(recipientFile, '/run/recipient.txt', true),
    '--entrypoint',
    'age',
    TOOLS_IMAGE,
    '-R',
    '/run/recipient.txt',
    '-o',
    '/work/dump.age',
    '/work/dump.custom',
  ];
}

export function cleanupArgs({ name, workDir }) {
  return [
    'create',
    '--rm',
    '--name',
    name,
    ...QUIET(),
    '--mount',
    mount(workDir, '/work'),
    '--entrypoint',
    '/bin/sh',
    TOOLS_IMAGE,
    '-c',
    // Empties the work directory except the ownership marker, which the host removes last.
    `for f in /work/* /work/.[!.]*; do [ -e "$f" ] || continue; [ "$f" = "/work/${TEMP_MARKER}" ] || rm -rf "$f"; done 2>/dev/null; exit 0`,
  ];
}

const nameOf = (args) => (args.includes('--name') ? args[args.indexOf('--name') + 1] : null);

// What the daemon is known to hold for a container name, as recorded in the ledger:
//   pending  - a create was sent and its outcome is not known. The daemon may still create it,
//              at any later time. Only seeing it in a listing settles that.
//   exists   - creation succeeded or the daemon listed the container by name.
// An empty listing alone never settles a pending create.

// Runs docker with the libpq variables in its environment. Variables from the caller's own
// environment with the same names are removed first, so only the configured source is used.
//
// Every container of this tool goes through #container(), cleanup included: create, then start,
// then reconcile. A result reports `absent` only after the daemon has been asked, the name is no
// longer pending, and nothing lists it. Callers must treat `absent: false` as a failure, because
// the container may still exist and may still write.
//
// Every management call is bounded (timeoutMs). A client that does not answer in time is killed
// and reaped, and its outcome is treated as unknown, never as a result.
export class DockerRunner {
  constructor({ bin = 'docker', containerEnv, env = process.env, timeoutMs = DOCKER_TIMEOUT_MS }) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    const inherited = Object.fromEntries(
      Object.entries(env).filter(([key]) => !SOURCE_ENV_NAMES.includes(key))
    );
    this.env = { ...inherited, ...containerEnv };
    this.children = new Map(); // tracked child -> { signalled, closed }
    this.containers = new Map(); // name -> pending or exists, for names not yet cleared
    this.aborted = false;
    this.shutdownPromise = null;
    this.ledger = null; // set by the pipeline once the lock is held
  }

  // Containers are recorded in the ledger before they are created, and forgotten only once absent.
  bindLedger(ledger) {
    this.ledger = ledger;
  }

  // One client, bounded when timeoutMs is set. A tracked client is one a shutdown must stop. A
  // client that outlives its timeout is killed; it is reported as timedOut and never as a result.
  // Resolves { code, signal, signalled, timedOut, stdout }. `signalled` is true when this process
  // sent it a signal: its daemon request may then still be pending.
  #spawnOnce(args, { timeoutMs = null, tracked = false, capture = false } = {}) {
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, {
        env: this.env,
        stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
      });
      const record = { signalled: false, closed: null };
      let settleClosed;
      record.closed = new Promise((done) => {
        settleClosed = done;
      });
      if (tracked) this.children.set(child, record);
      let stdout = '';
      if (capture)
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
      let timedOut = false;
      let finished = false;
      let timer = null;
      const finish = (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({
          code: timedOut ? 124 : (code ?? (signal ? 128 : 1)),
          signal: signal ?? null,
          signalled: record.signalled,
          timedOut,
          stdout,
        });
      };
      child.on('error', () => finish(127, null));
      child.on('close', (code, signal) => {
        this.children.delete(child);
        settleClosed();
        finish(code, signal);
      });
      if (timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true;
          record.signalled = true;
          child.kill('SIGKILL');
          // Reaping normally takes a moment; the caller is not held beyond REAP_MS.
          setTimeout(() => finish(null, 'SIGKILL'), REAP_MS).unref();
        }, timeoutMs);
      }
    });
  }

  // Management call that is not a container: version, image inspect, build. Bounded and untracked.
  async manage(args, { timeoutMs = this.timeoutMs } = {}) {
    if (this.aborted) throw new Interrupted('aborted');
    const result = await this.#spawnOnce(args, { timeoutMs });
    if (this.aborted) throw new Interrupted('aborted');
    return result;
  }

  // The daemon's answer about a name: 'present' when listed, 'absent' when the daemon answered
  // with an empty listing, 'unknown' when it did not answer or failed.
  async #observe(name) {
    const result = await this.#spawnOnce(listNamedArgs(name), {
      timeoutMs: this.timeoutMs,
      capture: true,
    });
    if (result.code !== 0) return 'unknown';
    return result.stdout.trim() === '' ? 'absent' : 'present';
  }

  #setState(name, state) {
    this.ledger?.setState(name, state); // durable first; throws when the ledger cannot be written
    this.containers.set(name, state);
  }

  // Clears a name only after it has existed and is now proven absent. A pending create may still
  // land, so leave its record alone until the daemon lists it. Container removal is followed by
  // a fresh listing, which is the proof; the removal itself is never the proof.
  // Returns true only when the name is cleared.
  async #reconcile(name) {
    const first = await this.#observe(name);
    if (first === 'present') this.#setState(name, 'exists');
    if (this.containers.get(name) === 'pending') return false;
    await this.#spawnOnce(removeArgs(name), { timeoutMs: this.timeoutMs });
    const seen = await this.#observe(name);
    if (seen === 'present') this.#setState(name, 'exists');
    if (seen !== 'absent') return false;
    try {
      this.ledger?.remove(name);
    } catch {
      return false;
    }
    this.containers.delete(name);
    return true;
  }

  // Never throws: any failure keeps the name.
  async #reconcileSafely(name) {
    try {
      return await this.#reconcile(name);
    } catch {
      return false;
    }
  }

  // create (bounded) -> start -a (unbounded) -> reconcile. The identity is recorded before create.
  // `boundedStart` is for the cleanup step only: it is a short removal, and once its create has exited 0
  // the container is known to exist, so a start that does not finish is killed and the container removed.
  async #container(createArgs, { afterAbort = false, boundedStart = false } = {}) {
    const name = nameOf(createArgs);
    this.ledger?.add(name); // durable before the daemon can know about the container
    this.containers.set(name, 'pending');
    const created = await this.#spawnOnce(createArgs, {
      timeoutMs: this.timeoutMs,
      tracked: true,
    });
    if (created.code === 0) {
      this.#setState(name, 'exists');
    }
    // A client error can follow a lost response while the daemon is still creating the container.
    if (created.code !== 0) {
      return { code: created.code, absent: await this.#reconcileSafely(name) };
    }
    if (this.aborted && !afterAbort) {
      // A stop arrived while the create was in flight: the container is known, so it is removed.
      return { code: 130, absent: await this.#reconcileSafely(name) };
    }
    const started = await this.#spawnOnce(startArgs(name), {
      tracked: true,
      timeoutMs: boundedStart ? this.timeoutMs : null,
    });
    return { code: started.code, absent: await this.#reconcileSafely(name) };
  }

  // Tracked container step. Rejects with Interrupted if abort() happens before or while it runs.
  async run(createArgs) {
    if (this.aborted) throw new Interrupted('aborted');
    const result = await this.#container(createArgs);
    if (this.aborted) throw new Interrupted('aborted');
    return result;
  }

  // Tracked container step that is allowed after shutdown(): the cleanup of the temporary directory
  // runs once every earlier container is proven gone, and it is tracked exactly like any other.
  runAfterShutdown(createArgs) {
    return this.#container(createArgs, { afterAbort: true, boundedStart: true });
  }

  // A name recorded by an earlier run, with the state the ledger holds for it.
  async reconcileRecorded(name, state) {
    this.containers.set(name, state);
    return this.#reconcileSafely(name);
  }

  // Stops this run: signals running docker clients, removes every container whose identity is still
  // known and proves each one absent. Resolves true only when no identity is left. Memoized: every
  // caller gets the same result. A signal that arrives later still stops any client that is running
  // (the cleanup container, for example), since the clients are signalled on every call.
  shutdown() {
    this.aborted = true;
    for (const [child, record] of this.children) {
      record.signalled = true;
      child.kill('SIGTERM');
    }
    this.shutdownPromise ??= this.stopChildren();
    return this.shutdownPromise;
  }

  // Order matters. SIGTERM to the start client is forwarded to its container, whose PID 1 is a
  // shell that ignores it while a child (pg_dump) is blocked: the client then never closes. So no
  // step waits on a client without a bound, and containers are removed by name before the last wait.
  async stopChildren() {
    await this.#closed(STOP_GRACE_MS);
    if (this.children.size > 0) await this.settle();
    await this.#closed(STOP_GRACE_MS);
    for (const [child, record] of this.children) {
      record.signalled = true;
      child.kill('SIGKILL');
    }
    await this.#closed(STOP_GRACE_MS);
    return this.settle();
  }

  // Resolves when every client running now has closed, or after `ms`, whichever comes first.
  #closed(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      Promise.all([...this.children.values()].map((record) => record.closed)).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // Removes and proves absent every container whose identity is still known. Up to three rounds;
  // a name that stays unproven keeps its identity and its ledger entry. True only when none is left.
  async settle() {
    for (let attempt = 0; attempt < 3 && this.containers.size > 0; attempt += 1) {
      for (const name of [...this.containers.keys()]) await this.#reconcileSafely(name);
    }
    return this.containers.size === 0;
  }
}
