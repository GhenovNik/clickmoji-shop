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

export function dumpArgs({ name, workDir }) {
  return [
    'run',
    '--rm',
    '--name',
    name,
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
    '--mount',
    mount(workDir, '/work'),
    '--entrypoint',
    '/bin/sh',
    TOOLS_IMAGE,
    '-c',
    'rm -rf /work/* /work/.[!.]* 2>/dev/null; exit 0',
  ];
}

// Runs docker with the libpq variables in its environment. Variables from the caller's own
// environment with the same names are removed first, so only the configured source is used.
export class DockerRunner {
  constructor({ bin = 'docker', containerEnv, env = process.env }) {
    this.bin = bin;
    const inherited = Object.fromEntries(
      Object.entries(env).filter(([key]) => !SOURCE_ENV_NAMES.includes(key))
    );
    this.env = { ...inherited, ...containerEnv };
    this.children = new Map(); // child -> Promise that settles when it closes
    this.containers = new Set();
    this.aborted = false;
  }

  // Unchecked call, used for cleanup after an interruption. Resolves with the exit code.
  exec(args) {
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { env: this.env, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 128));
    });
  }

  // Tracked call. Rejects with Interrupted if abort() happens before or while it runs.
  run(args) {
    if (this.aborted) return Promise.reject(new Interrupted('aborted'));
    const hasName = args.includes('--name');
    const name = hasName ? args[args.indexOf('--name') + 1] : null;
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { env: this.env, stdio: ['ignore', 'ignore', 'ignore'] });
      if (hasName) this.containers.add(name);
      let settle;
      const closed = new Promise((done) => {
        settle = done;
      });
      this.children.set(child, closed);
      const finish = (code) => {
        this.children.delete(child);
        if (hasName) this.containers.delete(name);
        settle();
        if (this.aborted) reject(new Interrupted('aborted'));
        else resolve({ code });
      };
      child.on('error', () => finish(127));
      child.on('close', (code) => finish(code ?? 128));
    });
  }

  // Kills running docker clients, waits for them, then removes containers they started.
  async abort() {
    this.aborted = true;
    for (const child of this.children.keys()) child.kill('SIGTERM');
    await Promise.all([...this.children.values()]);
    for (const name of [...this.containers]) await this.exec(['rm', '-f', name]);
  }
}
