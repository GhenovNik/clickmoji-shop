// One verified backup run: dump -> restore and compare -> encrypt -> publish -> prune.
// Plaintext and the temporary PostgreSQL cluster live only in a private temp directory,
// removed on success, failure and interruption. Old copies are pruned only after a new
// copy is complete, and only the retention policy decides what is removed.
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_NAME_PATTERN,
  BACKUP_PREFIX,
  BACKUP_SUFFIX,
  DROP_THRESHOLD_PERCENT,
  EXIT,
  META_DIR,
  MESSAGES,
  TEMP_PREFIX,
} from './constants.mjs';
import {
  compareIdentities,
  findDrops,
  parseCounts,
  parseIdentities,
  parseMigration,
} from './compare.mjs';
import { checkStatusTarget } from './config.mjs';
import { acquireLock, pidAlive } from './lock.mjs';
import { selectRetention } from './retention.mjs';
import { appendStatus, formatStatusLine } from './status.mjs';
import {
  buildImageArgs,
  cleanupArgs,
  dumpArgs,
  encryptArgs,
  inspectImageArgs,
  Interrupted,
  verifyArgs,
  versionArgs,
} from './docker.mjs';

// Written into every temporary directory before anything else goes in: which backup
// directory the run serves and which process owns it. Directories without it are never
// removed by a sweep.
const TEMP_MARKER = 'owner.json';

export class StepError extends Error {
  constructor(key, exit) {
    super(key);
    this.key = key;
    this.exit = exit;
  }
}

// 20261124T120000Z: sorts chronologically and is safe in file names.
export function stamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

const containerName = (step) => `clickmoji-backup-${step}-${crypto.randomBytes(6).toString('hex')}`;

function isNonEmptyFile(file) {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fsyncFile(file) {
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const backupKey = (backupDir) => crypto.createHash('sha256').update(backupDir).digest('hex');

function removeQuietly(target) {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Left in place; the caller checks whether the directory is gone.
  }
}

// Removes temporary directories that an earlier run of THIS backup directory left behind
// (for example after SIGKILL). A directory is removed only when its marker names this backup
// directory and a process that no longer exists. The caller holds this directory's lock, so
// no live run of it can exist. Other backup directories, unmarked entries and entries of
// live processes are never touched, whatever their age.
function sweepStaleTemp(tempRoot, backupDir) {
  let entries;
  try {
    entries = readdirSync(tempRoot);
  } catch {
    return;
  }
  const key = backupKey(backupDir);
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(tempRoot, entry);
    let marker;
    try {
      marker = JSON.parse(readFileSync(path.join(full, TEMP_MARKER), 'utf8'));
    } catch {
      continue;
    }
    if (marker?.backupKey !== key || !Number.isInteger(marker.pid)) continue;
    if (pidAlive(marker.pid)) continue;
    removeQuietly(full);
  }
}

// Completed copies in the backup directory, by the time in their file name.
export function listBackups(backupDir) {
  return readdirSync(backupDir)
    .map((name) => ({ name, match: BACKUP_NAME_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .map((entry) => {
      const raw = entry.match[1];
      const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
      return { name: entry.name, time: new Date(iso) };
    });
}

// Row counts of the newest copy that passed or was flagged in verification, if any.
function readPreviousCounts(backupDir) {
  const metaDir = path.join(backupDir, META_DIR);
  if (!existsSync(metaDir)) return null;
  const names = readdirSync(metaDir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.partial-'))
    .sort()
    .reverse();
  for (const name of names) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(path.join(metaDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (meta.verify === 'ok' || meta.verify === 'suspicious')
      return new Map(Object.entries(meta.counts));
  }
  return null;
}

// Copy into the backup directory under a partial name, then rename. A reader never sees
// a partial copy, and a failure leaves no partial files behind.
function publish({ backupDir, encryptedFile, name, meta }) {
  const metaDir = path.join(backupDir, META_DIR);
  mkdirSync(metaDir, { recursive: true, mode: 0o700 });
  const partialDump = path.join(backupDir, `.partial-${name}`);
  const partialMeta = path.join(metaDir, `.partial-${name}.json`);
  const finalDump = path.join(backupDir, name);
  const finalMeta = path.join(metaDir, `${name}.json`);
  let dumpMoved = false;
  try {
    if (existsSync(finalDump)) throw new Error('name taken');
    copyFileSync(encryptedFile, partialDump);
    fsyncFile(partialDump);
    writeFileSync(partialMeta, JSON.stringify(meta), { mode: 0o600 });
    renameSync(partialDump, finalDump);
    dumpMoved = true;
    renameSync(partialMeta, finalMeta);
  } catch {
    rmSync(partialDump, { force: true });
    rmSync(partialMeta, { force: true });
    if (dumpMoved) rmSync(finalDump, { force: true });
    throw new StepError('publish', EXIT.failed);
  }
}

// Throws StepError for a failed step, or Interrupted when the run is aborted.
// The lock is checked again before the copy becomes visible and before anything is pruned:
// a run that no longer holds it must not touch the shared backup names.
async function executeBackup({ config, docker, now, tempDir, lock }) {
  const run = async (args, key, exit = EXIT.failed) => {
    const result = await docker.run(args);
    if (result.code !== 0) throw new StepError(key, exit);
  };

  await run(versionArgs(), 'docker', EXIT.unavailable);

  if ((await docker.run(inspectImageArgs())).code !== 0) {
    await run(buildImageArgs(), 'image', EXIT.unavailable);
  }

  const startedAt = now();
  const dumpFile = path.join(tempDir, 'dump.custom');
  await run(dumpArgs({ name: containerName('dump'), workDir: tempDir }), 'dump');
  if (!isNonEmptyFile(dumpFile)) throw new StepError('dump', EXIT.failed);

  const reportDir = path.join(tempDir, 'out');
  mkdirSync(reportDir);
  await run(verifyArgs({ name: containerName('verify'), workDir: tempDir }), 'verify');

  let sourceIdentities;
  let sourceMigration;
  let identities;
  let migration;
  let counts;
  try {
    const sourceDir = path.join(reportDir, 'source');
    const restoredDir = path.join(reportDir, 'restored');
    sourceIdentities = parseIdentities(
      readFileSync(path.join(sourceDir, 'identities.tsv'), 'utf8')
    );
    sourceMigration = parseMigration(readFileSync(path.join(sourceDir, 'migration.txt'), 'utf8'));
    identities = parseIdentities(readFileSync(path.join(restoredDir, 'identities.tsv'), 'utf8'));
    migration = parseMigration(readFileSync(path.join(restoredDir, 'migration.txt'), 'utf8'));
    counts = parseCounts(readFileSync(path.join(restoredDir, 'counts.tsv'), 'utf8'));
  } catch {
    throw new StepError('verify', EXIT.failed);
  }
  if (compareIdentities(sourceIdentities, identities).length > 0)
    throw new StepError('verify', EXIT.failed);
  if (sourceMigration !== migration) throw new StepError('verify', EXIT.failed);
  for (const table of identities.keys()) {
    if (!counts.has(table)) throw new StepError('verify', EXIT.failed);
  }

  const previous = readPreviousCounts(config.backupDir);
  const drops = previous ? findDrops(previous, counts, DROP_THRESHOLD_PERCENT) : [];
  const verify = drops.length > 0 ? 'suspicious' : 'ok';

  const encryptedFile = path.join(tempDir, 'dump.age');
  await run(
    encryptArgs({
      name: containerName('encrypt'),
      workDir: tempDir,
      recipientFile: config.recipientFile,
    }),
    'encrypt'
  );
  if (!isNonEmptyFile(encryptedFile)) throw new StepError('encrypt', EXIT.failed);

  const name = `${BACKUP_PREFIX}${stamp(startedAt)}${BACKUP_SUFFIX}`;
  const meta = {
    name,
    createdAt: startedAt.toISOString(),
    sizeBytes: statSync(encryptedFile).size,
    sha256: sha256(encryptedFile),
    verify,
    migration,
    counts: Object.fromEntries(counts),
    flagged: drops.map((drop) => drop.table),
  };
  if (!lock.held()) throw new StepError('busy', EXIT.busy);
  publish({ backupDir: config.backupDir, encryptedFile, name, meta });

  // Pruning runs only after the new copy is in place, and only for the lock holder.
  let pruned = 'ok';
  if (!lock.held()) {
    pruned = 'skipped';
  } else {
    try {
      const { remove } = selectRetention(listBackups(config.backupDir));
      for (const old of remove) {
        rmSync(path.join(config.backupDir, old), { force: true });
        rmSync(path.join(config.backupDir, META_DIR, `${old}.json`), { force: true });
      }
    } catch {
      pruned = 'incomplete';
    }
  }
  return { name, sizeBytes: meta.sizeBytes, verify, pruned };
}

// Returns true when the directory is gone. Container-written files may belong to another
// uid, so a failed plain removal is retried from inside the tools image.
async function removeTemp(tempDir, docker) {
  removeQuietly(tempDir);
  if (!existsSync(tempDir)) return true;
  await docker.exec(cleanupArgs({ name: containerName('cleanup'), workDir: tempDir }));
  removeQuietly(tempDir);
  return !existsSync(tempDir);
}

function classify(error) {
  if (error instanceof StepError) return { ok: false, key: error.key, exit: error.exit };
  if (error instanceof Interrupted)
    return { ok: false, key: 'interrupted', exit: EXIT.interrupted };
  return { ok: false, key: 'internal', exit: EXIT.failed };
}

function report(config, now, result) {
  const when = now();
  const line = result.ok
    ? formatStatusLine({
        now: when,
        outcome: result.verify === 'suspicious' ? 'suspicious' : 'ok',
        detail: `size=${result.sizeBytes} verify=${result.verify} file=${result.name} prune=${result.pruned}`,
      })
    : formatStatusLine({ now: when, outcome: 'failed', detail: MESSAGES[result.key] });
  // The status path is checked again: a file may have been replaced since configuration. A
  // status line that cannot be written safely is dropped; the exit code still tells the outcome.
  try {
    checkStatusTarget(config.statusFile, config.backupDir);
    appendStatus(config.statusFile, line);
  } catch {
    // Nothing is written to a path that no longer qualifies.
  }
  return {
    ...result,
    exit: result.ok ? (result.verify === 'suspicious' ? EXIT.suspicious : EXIT.ok) : result.exit,
  };
}

// Never throws for an expected failure: the outcome is written to the status file and returned.
export async function runBackup({
  config,
  docker,
  now = () => new Date(),
  tempRoot = os.tmpdir(),
}) {
  mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = acquireLock(config.backupDir);
  } catch {
    return report(config, now, { ok: false, key: 'busy', exit: EXIT.busy });
  }
  if (!lock) return report(config, now, { ok: false, key: 'busy', exit: EXIT.busy });

  let result;
  let tempDir = null;
  try {
    sweepStaleTemp(tempRoot, config.backupDir);
    tempDir = mkdtempSync(path.join(tempRoot, TEMP_PREFIX));
    writeFileSync(
      path.join(tempDir, TEMP_MARKER),
      JSON.stringify({ pid: process.pid, backupKey: backupKey(config.backupDir) }),
      { mode: 0o600 }
    );
    result = { ok: true, ...(await executeBackup({ config, docker, now, tempDir, lock })) };
  } catch (error) {
    result = classify(error);
  }

  // Containers first. Until every container is proven gone, nothing may be removed under them:
  // the temporary directory and the lock stay as they are, and the lock is left to the next run
  // to take over once this process has exited.
  let containersGone = false;
  try {
    containersGone = await docker.shutdown();
  } catch {
    containersGone = false;
  }
  if (!containersGone) return report(config, now, { ok: false, key: 'cleanup', exit: EXIT.failed });

  try {
    if (tempDir && !(await removeTemp(tempDir, docker))) {
      // Plaintext left on disk is reported even when the copy itself succeeded.
      result = { ok: false, key: 'cleanup', exit: EXIT.failed };
    }
  } catch {
    result = { ok: false, key: 'cleanup', exit: EXIT.failed };
  } finally {
    try {
      lock.release();
    } catch {
      // Not released: the record names this process, which is gone when it exits; the next run takes it over.
    }
  }
  return report(config, now, result);
}
