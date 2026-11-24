// docker CLI wrapper. Argument builders are pure so tests can read exactly what runs.
// The source connection travels only in the environment: every `-e NAME` below forwards a
// variable by name (DATABASE_URL and the libpq variables derived from it), so no argv
// (host or container) contains the address, host, user or password. Inside the containers
// the tools read the libpq variables themselves.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMP_MARKER, TOOLS_IMAGE } from './constants.mjs';
import { LIBPQ_ENV_NAMES } from './config.mjs';

export const CONTAINER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'container'
);

export class Interrupted extends Error {}

// How long a docker client may take to close after a stop step before the next step runs.
export const STOP_GRACE_MS = 5000;

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

export function dumpArgs({ name, workDir }) {
  return [
    'run',
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
    'run',
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
    'run',
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
    'run',
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

// Runs docker with the libpq variables in its environment. Variables from the caller's own
// environment with the same names are removed first, so only the configured source is used.
//
// Container identities are kept from the moment a `docker run` starts until the daemon has
// shown that the container is gone. Killing the client does not remove its container, so the
// identity is never dropped because a client exited; shutdown() removes what is left.
//
// Every container of this tool goes through #start(), cleanup included. A client's exit code is
// not evidence that its container is gone: a result reports `absent` only after the daemon has
// been asked and listed no container of that name. Callers must treat `absent: false` as a
// failure, because the container may still exist and may still write.
export class DockerRunner {
  constructor({ bin = 'docker', containerEnv, env = process.env }) {
    this.bin = bin;
    const inherited = Object.fromEntries(
      Object.entries(env).filter(([key]) => !SOURCE_ENV_NAMES.includes(key))
    );
    this.env = { ...inherited, ...containerEnv };
    this.children = new Map(); // child -> Promise that settles when it closes
    this.containers = new Set(); // names whose removal has not been proven yet
    this.aborted = false;
    this.shutdownPromise = null;
    this.ledger = null; // set by the pipeline once the lock is held
  }

  // Containers are recorded in the ledger before they start, and forgotten only once absent.
  bindLedger(ledger) {
    this.ledger = ledger;
  }

  // Unchecked call, used for removal only. Resolves with the exit code.
  exec(args) {
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { env: this.env, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 128));
    });
  }

  // Unchecked call that returns stdout as well.
  query(args) {
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('error', () => resolve({ code: 127, stdout: '' }));
      child.on('close', (code) => resolve({ code: code ?? 128, stdout }));
    });
  }

  // True only when the daemon answers and lists no container with this name.
  async proveAbsent(name) {
    const result = await this.query(listNamedArgs(name));
    return result.code === 0 && result.stdout.trim() === '';
  }

  // Proves `name` absent and, only then, forgets it (ledger first, then the set). Returns false
  // when the container may still exist or when the ledger cannot be updated: the identity stays.
  async #forgetIfAbsent(name) {
    if (!(await this.proveAbsent(name))) return false;
    try {
      this.ledger?.remove(name);
      this.containers.delete(name);
      return true;
    } catch {
      return false;
    }
  }

  // Tracked call. Rejects with Interrupted if abort() happens before or while it runs.
  async run(args) {
    if (this.aborted) throw new Interrupted('aborted');
    const result = await this.#start(args);
    if (this.aborted) throw new Interrupted('aborted');
    return result;
  }

  // Tracked call that is allowed after shutdown(): the cleanup of the temporary directory runs once
  // every earlier container is proven gone, and it is tracked exactly like any other container.
  runAfterShutdown(args) {
    return this.#start(args);
  }

  // Starts one container. Resolves { code, absent }. The ledger write happens before spawn, so a
  // container that can exist is always recorded, even when this process dies right after.
  #start(args) {
    const name = nameOf(args);
    if (name) {
      this.ledger?.add(name); // durable before the daemon can know about the container
      this.containers.add(name);
    }
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { env: this.env, stdio: ['ignore', 'ignore', 'ignore'] });
      let settle;
      const closed = new Promise((done) => {
        settle = done;
      });
      this.children.set(child, closed);
      let finished = false;
      const finish = async (code) => {
        if (finished) return;
        finished = true;
        this.children.delete(child);
        settle();
        const absent = name ? await this.#forgetIfAbsent(name) : true;
        resolve({ code, absent });
      };
      child.on('error', () => finish(127));
      child.on('close', (code) => finish(code ?? 128));
    });
  }

  // Stops this run: kills running docker clients, removes every container whose identity is still
  // known and proves each one absent. Resolves true only when no identity is left. Memoized: every
  // caller gets the same result. A signal that arrives later still stops any client that is running
  // (the cleanup container, for example), since the clients are killed on every call; the containers
  // themselves are removed by settle().
  shutdown() {
    this.aborted = true;
    for (const child of this.children.keys()) child.kill('SIGTERM');
    this.shutdownPromise ??= this.stopChildren();
    return this.shutdownPromise;
  }

  // Order matters. SIGTERM to the docker client is forwarded to its container, whose PID 1 is a
  // shell that ignores it while a child (pg_dump) is blocked: the client then never closes. So no
  // step waits on a client without a bound, and containers are removed by name before the last wait.
  async stopChildren() {
    await this.#closed(STOP_GRACE_MS);
    if (this.children.size > 0) await this.settle();
    await this.#closed(STOP_GRACE_MS);
    for (const child of this.children.keys()) child.kill('SIGKILL');
    await this.#closed(STOP_GRACE_MS);
    return this.settle();
  }

  // Resolves when every client running now has closed, or after `ms`, whichever comes first.
  #closed(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      Promise.all([...this.children.values()]).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // Removes and proves absent every container whose identity is still known. Up to three rounds;
  // a container that stays unproven keeps its identity and its ledger entry. True only when none is left.
  async settle() {
    for (let attempt = 0; attempt < 3 && this.containers.size > 0; attempt += 1) {
      for (const name of [...this.containers]) {
        if (await this.#forgetIfAbsent(name)) continue;
        await this.exec(removeArgs(name));
        await this.#forgetIfAbsent(name);
      }
    }
    return this.containers.size === 0;
  }
}
