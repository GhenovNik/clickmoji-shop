// docker CLI wrapper. Argument builders are pure so tests can read exactly what runs.
// The source connection travels only in the environment: every `-e NAME` below forwards a
// variable by name (DATABASE_URL and the libpq variables derived from it), so no argv
// (host or container) contains the address, host, user or password. Inside the containers
// the tools read the libpq variables themselves.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS_IMAGE } from './constants.mjs';
import { LIBPQ_ENV_NAMES } from './config.mjs';

export const CONTAINER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'container'
);

export class Interrupted extends Error {}

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
    'rm -rf /work/* /work/.[!.]* 2>/dev/null; exit 0',
  ];
}

const nameOf = (args) => (args.includes('--name') ? args[args.indexOf('--name') + 1] : null);

// Runs docker with the libpq variables in its environment. Variables from the caller's own
// environment with the same names are removed first, so only the configured source is used.
//
// Container identities are kept from the moment a `docker run` starts until the daemon has
// shown that the container is gone. Killing the client does not remove its container, so the
// identity is never dropped because a client exited; shutdown() removes what is left.
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

  // Unchecked call, used for cleanup. Resolves with the exit code.
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

  // Tracked call. Rejects with Interrupted if abort() happens before or while it runs.
  async run(args) {
    if (this.aborted) throw new Interrupted('aborted');
    const name = nameOf(args);
    if (name) {
      this.ledger?.add(name); // durable before the daemon can know about the container
      this.containers.add(name);
    }
    return new Promise((resolve, reject) => {
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
        if (name && (await this.proveAbsent(name))) this.forget(name);
        if (this.aborted) reject(new Interrupted('aborted'));
        else resolve({ code });
      };
      child.on('error', () => finish(127));
      child.on('close', (code) => finish(code ?? 128));
    });
  }

  // Stops this run: kills running docker clients, waits for them to close, then removes every
  // container whose identity is still known and proves each one absent. Resolves true only
  // when no identity is left. Memoized: every caller gets the same result.
  shutdown() {
    this.aborted = true;
    this.shutdownPromise ??= this.stopAll();
    return this.shutdownPromise;
  }

  async stopAll() {
    for (const child of this.children.keys()) child.kill('SIGTERM');
    await Promise.all([...this.children.values()]);
    for (let attempt = 0; attempt < 3 && this.containers.size > 0; attempt += 1) {
      for (const name of [...this.containers]) {
        await this.exec(removeArgs(name));
        if (await this.proveAbsent(name)) this.forget(name);
      }
    }
    return this.containers.size === 0;
  }

  forget(name) {
    this.containers.delete(name);
    this.ledger?.remove(name);
  }
}
