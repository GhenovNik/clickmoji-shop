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
  TEMP_MARKER,
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
import { pidAlive } from './lock.mjs';
import { Ledger, LedgerError } from './ledger.mjs';
import { selectRetention } from './retention.mjs';
import { appendStatus, formatStatusLine } from './status.mjs';
import {
  buildImageArgs,
  cleanupArgs,
  dumpArgs,
  encryptArgs,
  inspectImageArgs,
  Interrupted,
  removeArgs,
  verifyArgs,
  versionArgs,
} from './docker.mjs';

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

// The host's own removal. Injected only by tests (see removeTemp), which need a deterministic refusal.
const hostRemove = (target) => rmSync(target, { recursive: true, force: true });

function removeQuietly(target, remove = hostRemove) {
  try {
    remove(target);
  } catch {
    // Left in place; the caller checks whether the directory is gone.
  }
}

// Recovers temporary directories that an earlier run of THIS backup directory left behind
// (for example after SIGKILL). A directory is recovered only when its marker names this backup
// directory and a process that no longer exists. The caller holds this directory's lock, so
// no live run of it can exist. Other backup directories, unmarked entries and entries of
// live processes are never touched, whatever their age.
// Each recovered directory goes through removeTemp, the same path a run uses. One that stays
// is a failure: the run stops before any dump, publish or prune.
async function sweepStaleTemp(tempRoot, backupDir, docker) {
  let entries;
  try {
    entries = readdirSync(tempRoot);
  } catch {
    throw new StepError('cleanup', EXIT.failed);
  }
  const key = backupKey(backupDir);
  const stale = [];
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
    stale.push(full);
  }
  let stuck = false;
  for (const dir of stale) {
    let gone = false;
    try {
      gone = await removeTemp(dir, docker);
    } catch {
      gone = false;
    }
    if (!gone) stuck = true;
  }
  if (stuck) throw new StepError('cleanup', EXIT.failed);
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
  // A step counts only when its client exited 0 AND the daemon has been seen to hold no container
  // of its name. A zero exit alone is not proof: the daemon may be unreachable or still hold it.
  const run = async (args, key, exit = EXIT.failed) => {
    const result = await docker.run(args);
    if (result.code !== 0) throw new StepError(key, exit);
    if (!result.absent) throw new StepError('containers', EXIT.failed);
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

// Containers a previous run started and could not prove gone (or was killed before it could).
// Each is removed again and must be proven absent; until all are, this run does nothing else.
async function recoverContainers(docker, ledger) {
  let names;
  try {
    names = ledger.list();
  } catch (error) {
    if (error instanceof LedgerError) throw new StepError('containers', EXIT.failed);
    throw error;
  }
  for (const name of names) {
    await docker.exec(removeArgs(name));
    if (!(await docker.proveAbsent(name))) throw new StepError('containers', EXIT.failed);
    ledger.remove(name);
  }
}

// Every entry of the directory except the ownership marker.
function removeContents(tempDir, remove) {
  let entries;
  try {
    entries = readdirSync(tempDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== TEMP_MARKER) removeQuietly(path.join(tempDir, entry), remove);
  }
}

// True when anything but the marker is left, or when that cannot be told.
function contentsLeft(tempDir) {
  if (!existsSync(tempDir)) return false;
  try {
    return readdirSync(tempDir).some((entry) => entry !== TEMP_MARKER);
  } catch {
    return true;
  }
}

// Returns true only when the directory is gone. Contents go first, on the host. Container-written
// files may belong to another uid, so anything left is emptied from inside the tools image. That
// fallback is a container like any other: tracked in the ledger before it starts. Its absence must
// be proven (absent) before the host looks again; an unproven fallback stops everything here, so
// nothing is removed under a container that may still exist. The marker goes last, so a directory
// that is not fully removed keeps the marker a later sweep needs. Exported for the real-Docker test.
export async function removeTemp(tempDir, docker, remove = hostRemove) {
  removeContents(tempDir, remove);
  if (contentsLeft(tempDir)) {
    const cleanup = await docker.runAfterShutdown(
      cleanupArgs({ name: containerName('cleanup'), workDir: tempDir })
    );
    if (!cleanup.absent) return false;
    removeContents(tempDir, remove);
    if (contentsLeft(tempDir)) return false;
  }
  removeQuietly(path.join(tempDir, TEMP_MARKER), remove);
  removeQuietly(tempDir, remove);
  return !existsSync(tempDir);
}

function classify(error) {
  if (error instanceof StepError) return { ok: false, key: error.key, exit: error.exit };
  if (error instanceof Interrupted)
    return { ok: false, key: 'interrupted', exit: EXIT.interrupted };
  return { ok: false, key: 'internal', exit: EXIT.failed };
}

// `saved` is true when the encrypted copy was published, whatever happened to cleanup afterwards.
// A status line that cannot be written (the path no longer qualifies, or the write fails) is
// reported as statusWritten: false. When the copy was saved, that gets its own exit code, so the
// copy is not mistaken for a missing one.
function report(config, now, result, saved = false) {
  const when = now();
  const line = result.ok
    ? formatStatusLine({
        now: when,
        outcome: result.verify === 'suspicious' ? 'suspicious' : 'ok',
        detail: `size=${result.sizeBytes} verify=${result.verify} file=${result.name} prune=${result.pruned}`,
      })
    : formatStatusLine({ now: when, outcome: 'failed', detail: MESSAGES[result.key] });
  // The status path is checked again: a file may have been replaced since configuration.
  let statusWritten = true;
  try {
    checkStatusTarget(config.statusFile, config.backupDir);
    appendStatus(config.statusFile, line);
  } catch {
    statusWritten = false; // nothing is written to a path that no longer qualifies
  }
  const outcomeExit = result.ok
    ? result.verify === 'suspicious'
      ? EXIT.suspicious
      : EXIT.ok
    : result.exit;
  return {
    ...result,
    saved,
    statusWritten,
    exit: !statusWritten && saved ? EXIT.statusFailed : outcomeExit,
  };
}

// The caller is the writer: it runs under the lock it was started with (see lock.mjs), passed in
// as `lock`. Without a held lock nothing is done and the run is reported busy.
// Never throws for an expected failure: the outcome is written to the status file and returned.
// The lock is held until the very end: containers, plaintext and the temporary directory are all
// dealt with before release() lets the next process in.
export async function runBackup({
  config,
  docker,
  lock,
  now = () => new Date(),
  tempRoot = os.tmpdir(),
}) {
  mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  if (!lock?.held()) return reportBusy(config, now);

  const ledger = new Ledger(config.backupDir);
  docker.bindLedger(ledger);

  let result;
  let saved = false;
  let tempDir = null;
  try {
    await recoverContainers(docker, ledger);
    await sweepStaleTemp(tempRoot, config.backupDir, docker);
    tempDir = mkdtempSync(path.join(tempRoot, TEMP_PREFIX));
    writeFileSync(
      path.join(tempDir, TEMP_MARKER),
      JSON.stringify({ pid: process.pid, backupKey: backupKey(config.backupDir) }),
      { mode: 0o600 }
    );
    result = { ok: true, ...(await executeBackup({ config, docker, now, tempDir, lock })) };
    saved = true; // publish is the last step that can fail; nothing after it can undo it
  } catch (error) {
    result = classify(error);
  }

  // Containers first. Until every container is proven gone, nothing may be removed under them.
  // A container that stays unproven remains in the ledger, which blocks every later run until
  // it is proven gone; the temporary directory is kept for the same reason.
  let containersGone = false;
  try {
    containersGone = await docker.shutdown();
  } catch {
    containersGone = false;
  }
  if (!containersGone) {
    await releaseQuietly(lock);
    return report(config, now, { ok: false, key: 'containers', exit: EXIT.failed }, saved);
  }

  let removed = true;
  try {
    if (tempDir) removed = await removeTemp(tempDir, docker);
  } catch {
    removed = false;
  }
  // The cleanup container was started after shutdown(): it must be proven gone as well.
  let allGone = false;
  try {
    allGone = await docker.settle();
  } catch {
    allGone = false;
  }
  await releaseQuietly(lock);
  if (!allGone)
    return report(config, now, { ok: false, key: 'containers', exit: EXIT.failed }, saved);
  if (!removed) {
    // Plaintext left on disk is reported even when the copy itself succeeded.
    result = { ok: false, key: 'cleanup', exit: EXIT.failed };
  }
  return report(config, now, result, saved);
}

// Release is the last thing a run does. A failure here cannot leave a live owner behind: the
// descriptor belongs to this process, and the kernel frees the lock when it exits.
async function releaseQuietly(lock) {
  try {
    await lock.release();
  } catch {
    // Nothing more to do: the process is about to exit, and so is its hold on the lock.
  }
}

// The outcome of a run that could not take the lock. Used by the entry point, which holds no lock
// when another process does.
export function reportBusy(config, now = () => new Date()) {
  return report(config, now, { ok: false, key: 'busy', exit: EXIT.busy });
}
