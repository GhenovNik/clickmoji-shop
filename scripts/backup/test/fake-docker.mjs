#!/usr/bin/env node
// Test double for the docker CLI. It appends every argv and comparison results for the forwarded libpq variables
// to FAKE_DOCKER_LOG (a file inside the test sandbox) and emulates the few commands the
// pipeline issues. Behaviour is selected with FAKE_DOCKER_MODE:
//   ok | docker-down | pull-fail | dump-fail | interrupt | verify-fail | encrypt-fail | cleanup-fail
// cleanup-fail leaves a directory the host cannot remove and makes the in-image cleanup a no-op.
// interrupt starts a dump that never ends; when its client is killed the container survives,
// as it does in the daemon, until `docker rm -f` removes it.
// FAKE_DOCKER_RM=fail makes `docker rm -f` fail, so a container can outlive the run.
// cleanup-hang is cleanup-fail with the in-image cleanup container kept running until something
// removes it (`docker rm -f`), as a daemon keeps it when its client was killed.
// FAKE_DOCKER_PS=fail makes `docker ps` fail: the daemon cannot be asked, so no absence is proven.
// FAKE_DOCKER_PS=fail-cleanup makes it fail only for cleanup containers: the fallback is unproven.
// FAKE_DOCKER_HANG=<cmd,...> makes the named subcommands (version, image, build, ps, rm, create,
// start) never answer: the client stays alive until the caller kills it.
// FAKE_DOCKER_CREATE=disconnect simulates a client error after sending a delayed create.
// FAKE_DOCKER_LATE_CREATE=<gate file> makes `docker create` hang, as a client whose request the daemon
// has not answered. The daemon still creates the container once the gate file exists, even after the
// client has been killed: the create lands at a time the test chooses.
// FAKE_SWAP_STATUS=<path> replaces the status file by a directory when the run starts, so the
// status line cannot be written any more (the path was replaced after configuration).
// Each `docker create` with --name is logged with ledgerHas: whether FAKE_WATCH_LEDGER (the ledger
// file) already named that container at the moment it started.
//
// Containers live in FAKE_DOCKER_STATE/containers (one file per name, holding the create argv). `create`
// registers the container; `start -a` runs it with the arguments it was created with; --rm removes it when
// it exits normally. Container output goes to FAKE_DAEMON_LOG unless the container was created with
// `--log-driver none`, which is how the daemon's own log is emulated.
// Every removal is recorded in FAKE_DOCKER_STATE/events.jsonl with whether the work directory
// existed and whether the backup lock was still held at that moment.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

// Source variables the host forwards by name. Values are compared in memory.
const PG_NAMES = [
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGCONNECT_TIMEOUT',
  'PGAPPNAME',
  'PGCHANNELBINDING',
  'PGOPTIONS',
];
const expected = JSON.parse(process.env.FAKE_EXPECTED_CONNECTION ?? '{}');

// The invocation's own argv. A `start` runs with the argv its container was created with.
let argv = process.argv.slice(2);
const command = argv[0];
const mode = process.env.FAKE_DOCKER_MODE || 'ok';
const STATE = process.env.FAKE_DOCKER_STATE;
const REGISTRY = STATE ? path.join(STATE, 'containers') : null;
const HANG = new Set((process.env.FAKE_DOCKER_HANG ?? '').split(',').filter(Boolean));

if (process.env.FAKE_DOCKER_LOG) {
  const nameArg = argv.includes('--name') ? argv[argv.indexOf('--name') + 1] : null;
  const ledgerFile = process.env.FAKE_WATCH_LEDGER;
  const recipientMount = mountSource('/run/recipient.txt');
  appendFileSync(
    process.env.FAKE_DOCKER_LOG,
    `${JSON.stringify({
      argv,
      // Docker passes a variable into the container only when argv names it with -e.
      forwarded: Object.fromEntries(
        PG_NAMES.filter((name) => argv.includes(name) && process.env[name] !== undefined).map(
          (name) => [name, process.env[name] === expected[name]]
        )
      ),
      ledgerHas:
        nameArg && ledgerFile
          ? existsSync(ledgerFile) && readFileSync(ledgerFile, 'utf8').includes(nameArg)
          : null,
      recipientUsed:
        recipientMount && existsSync(recipientMount)
          ? readFileSync(recipientMount, 'utf8').trim()
          : null,
    })}\n`
  );
}

// Host directory mounted at the given container path.
function mountSource(target) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--mount') continue;
    const match = /source=([^,]+),target=([^,]+)/.exec(argv[i + 1]);
    if (match && match[2] === target) return match[1];
  }
  return null;
}

const entrypoint = () => argv[argv.indexOf('--entrypoint') + 1];
const optionValue = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);

function containerFile(name) {
  return path.join(REGISTRY, name);
}

function containerExists(name) {
  return REGISTRY !== null && existsSync(containerFile(name));
}

function recordEvent(event) {
  mkdirSync(STATE, { recursive: true });
  appendFileSync(path.join(STATE, 'events.jsonl'), `${JSON.stringify(event)}\n`);
}

// What a container prints. Shown only when the daemon keeps container logs.
function containerOutput(text, quiet) {
  process.stderr.write(`${text}\n`);
  if (!quiet && process.env.FAKE_DAEMON_LOG)
    appendFileSync(process.env.FAKE_DAEMON_LOG, `${text}\n`);
}

function writeReports(workDir) {
  const out = path.join(workDir, 'out');
  mkdirSync(path.join(out, 'source'), { recursive: true });
  mkdirSync(path.join(out, 'restored'), { recursive: true });
  const identities = process.env.FAKE_IDENTITIES ?? 'a\tid int4 NO\nb\tid int4 NO';
  const restoredIdentities = process.env.FAKE_RESTORED_IDENTITIES ?? identities;
  const counts = process.env.FAKE_COUNTS ?? '{"a":10,"b":20}';
  const countLines = Object.entries(JSON.parse(counts))
    .map(([table, n]) => `${table}\t${n}`)
    .join('\n');
  writeFileSync(path.join(out, 'source', 'identities.tsv'), `${identities}\n`);
  writeFileSync(
    path.join(out, 'source', 'migration.txt'),
    `${process.env.FAKE_MIGRATION ?? 'm_2'}\n`
  );
  writeFileSync(path.join(out, 'restored', 'identities.tsv'), `${restoredIdentities}\n`);
  writeFileSync(
    path.join(out, 'restored', 'migration.txt'),
    `${process.env.FAKE_RESTORED_MIGRATION ?? process.env.FAKE_MIGRATION ?? 'm_2'}\n`
  );
  writeFileSync(path.join(out, 'restored', 'counts.tsv'), `${countLines}\n`);
  if (mode === 'cleanup-fail' || mode === 'cleanup-hang') {
    // A read-only directory with a file in it: the host cannot delete it without privilege.
    chmodSync(path.join(out, 'restored'), 0o555);
  }
}

// Never answers. The caller's timeout is what ends this client.
function hang() {
  setInterval(() => {}, 1000);
}

// Writes a container registration once FAKE_DOCKER_LATE_CREATE's gate file exists. Runs detached, so
// it outlives the create client that the test kills. Its inputs come from the environment.
const LATE_WRITER = `
const fs = require('fs');
const path = require('path');
const deadline = Date.now() + 60000;
const timer = setInterval(() => {
  if (fs.existsSync(process.env.GATE)) {
    clearInterval(timer);
    fs.mkdirSync(path.dirname(process.env.FILE), { recursive: true });
    fs.writeFileSync(process.env.FILE, process.env.BODY);
    process.exit(0);
  }
  if (Date.now() > deadline) process.exit(0);
}, 20);
`;

function main() {
  if (HANG.has(command)) return hang();

  if (command === 'version') {
    if (process.env.FAKE_SWAP_STATUS) {
      rmSync(process.env.FAKE_SWAP_STATUS, { recursive: true, force: true });
      mkdirSync(process.env.FAKE_SWAP_STATUS);
    }
    if (mode === 'docker-down') {
      // Real docker may echo the connection string; the pipeline must not forward it.
      process.stderr.write(`Cannot connect to ${process.env.PGPASSWORD ?? ''}\n`);
      process.exit(1);
    }
    process.stdout.write('29.9.3\n');
    process.exit(0);
  }

  if (command === 'image' && argv[1] === 'inspect') process.exit(mode === 'pull-fail' ? 1 : 0);
  if (command === 'build') process.exit(mode === 'pull-fail' ? 1 : 0);

  if (command === 'ps') {
    if (process.env.FAKE_DOCKER_PS === 'fail') process.exit(1);
    const filter = optionValue('--filter') ?? '';
    const match = /^name=\^(.*)\$$/.exec(filter);
    if (process.env.FAKE_DOCKER_PS === 'fail-cleanup' && match?.[1].includes('-cleanup-'))
      process.exit(1);
    if (!match || !REGISTRY || !existsSync(REGISTRY)) process.exit(0);
    for (const entry of readdirSync(REGISTRY)) {
      if (entry === match[1]) process.stdout.write(`${entry}\n`);
    }
    process.exit(0);
  }

  if (command === 'rm') {
    const name = argv[argv.length - 1];
    if (process.env.FAKE_DOCKER_RM === 'fail' || !containerExists(name)) process.exit(1);
    const stored = JSON.parse(readFileSync(containerFile(name), 'utf8'));
    const work = mountFrom(stored.argv, '/work');
    const lock = process.env.FAKE_WATCH_LOCK ?? null;
    recordEvent({
      op: 'rm',
      name,
      workDirExists: work ? existsSync(work) : null,
      lockHeld: lock ? lockHeldBy(lock) : null,
    });
    rmSync(containerFile(name), { force: true });
    process.exit(0);
  }

  if (command === 'create') {
    const name = optionValue('--name');
    const body = JSON.stringify({ argv });
    if (process.env.FAKE_DOCKER_LATE_CREATE) {
      // The daemon takes the request, but the client never hears back in time: the create lands only
      // when the test releases the gate, and this client is the one the caller kills.
      mkdirSync(REGISTRY, { recursive: true });
      spawn(process.execPath, ['-e', LATE_WRITER], {
        detached: true,
        stdio: 'ignore',
        env: {
          GATE: process.env.FAKE_DOCKER_LATE_CREATE,
          FILE: containerFile(name),
          BODY: body,
        },
      }).unref();
      if (process.env.FAKE_DOCKER_CREATE === 'disconnect') process.exit(1);
      return hang();
    }
    mkdirSync(REGISTRY, { recursive: true });
    writeFileSync(containerFile(name), body);
    process.exit(0);
  }

  if (command === 'start') {
    const name = argv[argv.length - 1];
    if (!containerExists(name)) process.exit(1);
    // The container runs with the arguments it was created with.
    argv = JSON.parse(readFileSync(containerFile(name), 'utf8')).argv;
    const quiet = optionValue('--log-driver') === 'none';
    const code = runContainer(quiet);
    if (code === undefined) {
      // Keeps running: the container stays registered. Its client lives as long as the container and
      // exits when `docker rm -f` removes it, as a real client does.
      setInterval(() => {
        if (!existsSync(containerFile(name))) process.exit(0);
      }, 50);
      return undefined;
    }
    if (argv.includes('--rm')) rmSync(containerFile(name), { force: true });
    process.exit(code);
  }

  process.exit(2);
}

// Host directory mounted at /work in the argv a container was created with.
function mountFrom(list, target) {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] !== '--mount') continue;
    const match = /source=([^,]+),target=([^,]+)/.exec(list[i + 1]);
    if (match && match[2] === target) return match[1];
  }
  return null;
}

// True while another open file description holds an exclusive flock on the lock file.
function lockHeldBy(file) {
  const probe = 'open my $f, "<", $ARGV[0] or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 3);';
  return spawnSync('/usr/bin/perl', ['-MFcntl=:flock', '-e', probe, file]).status === 3;
}

// Returns the container's exit code, or undefined when the container keeps running.
function runContainer(quiet) {
  const workDir = mountSource('/work');
  if (argv.includes('/opt/backup/dump.sh')) {
    writeFileSync(path.join(workDir, 'dump.custom'), 'FAKE-DUMP');
    if (process.env.FAKE_SWAP_RECIPIENT_FILE && process.env.FAKE_SWAP_RECIPIENT_VALUE) {
      writeFileSync(
        process.env.FAKE_SWAP_RECIPIENT_FILE,
        `${process.env.FAKE_SWAP_RECIPIENT_VALUE}\n`
      );
    }
    if (mode === 'interrupt') {
      // Plaintext exists now; the host must kill this process and remove the container.
      return undefined;
    }
    if (mode === 'dump-fail') {
      containerOutput(
        `pg_dump: error: connection failed for ${process.env.PGPASSWORD ?? ''}`,
        quiet
      );
    }
    return mode === 'dump-fail' ? 1 : 0;
  }
  if (argv.includes('/opt/backup/verify.sh')) {
    if (mode === 'verify-fail') {
      containerOutput(
        `verify: error: connection failed for ${process.env.PGPASSWORD ?? ''}`,
        quiet
      );
      return 1;
    }
    writeReports(workDir);
    return 0;
  }
  if (entrypoint() === 'age') {
    if (mode === 'encrypt-fail') return 1;
    writeFileSync(path.join(workDir, 'dump.age'), 'age-encryption.org/v1\nFAKE-CIPHERTEXT\n');
    return 0;
  }
  if (argv.some((arg) => arg.includes('rm -rf'))) {
    if (mode === 'cleanup-hang') return undefined;
    if (mode === 'cleanup-fail') return 0;
    // The real script keeps the ownership marker (owner.json) for the host to remove last.
    for (const entry of readdirSync(workDir))
      if (entry !== 'owner.json')
        rmSync(path.join(workDir, entry), { recursive: true, force: true });
    return 0;
  }
  return 2;
}

main();
