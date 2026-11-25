// Operator confirmation state and CLI handler for restoring the first encrypted (.dump.age)
// backup before automatically purging prior unencrypted (.dump) copies on the next successful run.
import { lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './config.mjs';
import {
  CONFIRMED_RECIPIENT_STATE_NAME,
  ENCRYPTED_CONFIRM_STATE_NAME,
  EXIT,
  META_DIR,
} from './constants.mjs';
import { canonicalPath, isInsidePath, verifyBackupDirGitIgnored } from './git.mjs';
import {
  ensurePrivateDir,
  isValidCounts,
  listBackups,
  parseStampTime,
  report,
  reportBusy,
  reportFailure,
  sha256Buffer,
  sha256File,
  sha256Text,
  StepError,
  writePrivateText,
} from './storage.mjs';

const ENCRYPTED_NAME_PATTERN = /^clickmoji-(\d{8}T\d{6}Z)\.dump\.age$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function confirmationPaths(backupDir) {
  const metaDir = path.join(backupDir, META_DIR);
  return {
    metaDir,
    stateFile: path.join(metaDir, ENCRYPTED_CONFIRM_STATE_NAME),
    partialFile: path.join(metaDir, `.partial-${ENCRYPTED_CONFIRM_STATE_NAME}`),
  };
}

export function recipientPolicyPaths(backupDir) {
  const metaDir = path.join(backupDir, META_DIR);
  return {
    metaDir,
    policyFile: path.join(metaDir, CONFIRMED_RECIPIENT_STATE_NAME),
    partialFile: path.join(metaDir, `.partial-${CONFIRMED_RECIPIENT_STATE_NAME}`),
  };
}

export function confirmationTargetPaths(backupDir) {
  const { stateFile, partialFile } = confirmationPaths(backupDir);
  const { policyFile, partialFile: partialPolicyFile } = recipientPolicyPaths(backupDir);
  return [stateFile, partialFile, policyFile, partialPolicyFile];
}

function hasNewerPlainCopy(entries, targetTime, targetName) {
  return entries.some(
    (entry) =>
      !entry.encrypted &&
      (entry.time > targetTime ||
        (entry.time.getTime() === targetTime.getTime() && entry.name > targetName))
  );
}

// Validates that fileName is a completed, accepted, uncorrupted .dump.age artifact in backupDir
// and returns its exact ciphertext fingerprint and metadata hash.
export function inspectEncryptedArtifact(backupDir, fileName) {
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName) {
    throw new StepError('confirmTarget', EXIT.failed);
  }
  const match = ENCRYPTED_NAME_PATTERN.exec(fileName);
  if (!match) {
    throw new StepError('confirmTarget', EXIT.failed);
  }

  const dumpPath = path.join(backupDir, fileName);
  let dumpLstat;
  try {
    dumpLstat = lstatSync(dumpPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new StepError('confirmTarget', EXIT.failed);
    throw new StepError('confirmCorrupt', EXIT.failed);
  }
  if (dumpLstat.isSymbolicLink() || !dumpLstat.isFile() || dumpLstat.nlink > 1) {
    throw new StepError('confirmTarget', EXIT.failed);
  }
  if (dumpLstat.size <= 0) {
    throw new StepError('confirmCorrupt', EXIT.failed);
  }

  const metaPath = path.join(backupDir, META_DIR, `${fileName}.json`);
  let metaLstat;
  try {
    metaLstat = lstatSync(metaPath);
  } catch {
    throw new StepError('confirmTarget', EXIT.failed);
  }
  if (metaLstat.isSymbolicLink() || !metaLstat.isFile() || metaLstat.nlink > 1) {
    throw new StepError('confirmTarget', EXIT.failed);
  }

  let metaBuf;
  let meta;
  try {
    metaBuf = readFileSync(metaPath);
    meta = JSON.parse(metaBuf.toString('utf8'));
  } catch {
    throw new StepError('confirmTarget', EXIT.failed);
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new StepError('confirmTarget', EXIT.failed);
  }
  if (meta.name !== undefined && meta.name !== fileName) {
    throw new StepError('confirmTarget', EXIT.failed);
  }
  if (meta.encrypted !== undefined && meta.encrypted !== true) {
    throw new StepError('confirmTarget', EXIT.failed);
  }
  if (meta.verify !== 'ok' || !isValidCounts(meta.counts)) {
    throw new StepError('confirmTarget', EXIT.failed);
  }

  let actualSha256;
  try {
    actualSha256 = sha256File(dumpPath);
  } catch {
    throw new StepError('confirmCorrupt', EXIT.failed);
  }
  if (
    !Number.isInteger(meta.sizeBytes) ||
    meta.sizeBytes <= 0 ||
    typeof meta.sha256 !== 'string' ||
    !SHA256_HEX.test(meta.sha256)
  ) {
    throw new StepError('confirmCorrupt', EXIT.failed);
  }
  if (meta.sizeBytes !== dumpLstat.size || meta.sha256 !== actualSha256) {
    throw new StepError('confirmCorrupt', EXIT.failed);
  }

  const time = parseStampTime(match[1]);
  return {
    file: fileName,
    time,
    sizeBytes: dumpLstat.size,
    sha256: actualSha256,
    metaSha256: sha256Buffer(metaBuf),
    createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : time.toISOString(),
    recipientSha256:
      typeof meta.recipientSha256 === 'string' && SHA256_HEX.test(meta.recipientSha256)
        ? meta.recipientSha256
        : null,
  };
}

// Reads the confirmation state file. Returns null on ENOENT, throws StepError('confirmState')
// when the state file is symlinked, hardlinked, unreadable, or malformed (fail closed).
export function readConfirmationState(backupDir) {
  const { stateFile } = confirmationPaths(backupDir);
  let stat;
  try {
    stat = lstatSync(stateFile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StepError('confirmState', EXIT.failed);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw new StepError('confirmState', EXIT.failed);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    throw new StepError('confirmState', EXIT.failed);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.file !== 'string' ||
    !ENCRYPTED_NAME_PATTERN.test(parsed.file) ||
    typeof parsed.confirmedAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.confirmedAt)) ||
    typeof parsed.sha256 !== 'string' ||
    !SHA256_HEX.test(parsed.sha256) ||
    !Number.isInteger(parsed.sizeBytes) ||
    parsed.sizeBytes <= 0 ||
    typeof parsed.metaSha256 !== 'string' ||
    !SHA256_HEX.test(parsed.metaSha256) ||
    typeof parsed.createdAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.createdAt)) ||
    (parsed.recipientSha256 !== null &&
      parsed.recipientSha256 !== undefined &&
      (typeof parsed.recipientSha256 !== 'string' || !SHA256_HEX.test(parsed.recipientSha256)))
  ) {
    throw new StepError('confirmState', EXIT.failed);
  }
  return {
    version: 1,
    file: parsed.file,
    confirmedAt: parsed.confirmedAt,
    sha256: parsed.sha256,
    sizeBytes: parsed.sizeBytes,
    metaSha256: parsed.metaSha256,
    createdAt: parsed.createdAt,
    recipientSha256: parsed.recipientSha256 ?? null,
  };
}

// Reads the durable confirmed recipient policy. Returns null on ENOENT, throws
// StepError('recipientPolicy') when symlinked, hardlinked, unreadable, or malformed (fail closed).
export function readRecipientPolicy(backupDir) {
  const { policyFile } = recipientPolicyPaths(backupDir);
  let stat;
  try {
    stat = lstatSync(policyFile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StepError('recipientPolicy', EXIT.failed);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw new StepError('recipientPolicy', EXIT.failed);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(policyFile, 'utf8'));
  } catch {
    throw new StepError('recipientPolicy', EXIT.failed);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.recipientSha256 !== 'string' ||
    !SHA256_HEX.test(parsed.recipientSha256) ||
    typeof parsed.confirmedAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.confirmedAt)) ||
    typeof parsed.file !== 'string' ||
    !ENCRYPTED_NAME_PATTERN.test(parsed.file) ||
    typeof parsed.sha256 !== 'string' ||
    !SHA256_HEX.test(parsed.sha256)
  ) {
    throw new StepError('recipientPolicy', EXIT.failed);
  }
  return {
    version: 1,
    recipientSha256: parsed.recipientSha256,
    confirmedAt: parsed.confirmedAt,
    file: parsed.file,
    sha256: parsed.sha256,
  };
}

// Validates that an existing confirmation authorizes purging prior unencrypted copies for the
// current transition: target file still exists, matches exact sha256/sizeBytes/metaSha256,
// matches recipient (when recorded) and durable recipient policy, and no accepted unencrypted copy is newer.
export function validateConfirmationForTransition({
  backupDir,
  entries,
  currentRecipient = null,
  recipientPolicy = undefined,
}) {
  const state = readConfirmationState(backupDir);
  if (!state) return { valid: false, reason: 'missing', state: null };

  const policy = recipientPolicy === undefined ? readRecipientPolicy(backupDir) : recipientPolicy;

  const match = ENCRYPTED_NAME_PATTERN.exec(state.file);
  const targetTime = parseStampTime(match[1]);
  if (hasNewerPlainCopy(entries, targetTime, state.file)) {
    return { valid: false, reason: 'stale', state };
  }

  let artifact;
  try {
    artifact = inspectEncryptedArtifact(backupDir, state.file);
  } catch {
    return { valid: false, reason: 'corrupt-or-missing', state };
  }

  if (
    artifact.sha256 !== state.sha256 ||
    artifact.sizeBytes !== state.sizeBytes ||
    artifact.metaSha256 !== state.metaSha256
  ) {
    return { valid: false, reason: 'substituted', state };
  }

  if (
    state.recipientSha256 &&
    currentRecipient &&
    sha256Text(currentRecipient) !== state.recipientSha256
  ) {
    return { valid: false, reason: 'recipient-mismatch', state };
  }

  if (policy && state.recipientSha256 !== policy.recipientSha256) {
    return { valid: false, reason: 'recipient-mismatch', state };
  }

  return { valid: true, reason: 'ok', state };
}

function writeAtomicMetaJson(backupDir, targetFile, partialFile, record, errorKey) {
  const { metaDir } = confirmationPaths(backupDir);
  ensurePrivateDir(backupDir);
  ensurePrivateDir(metaDir);
  try {
    const existing = lstatSync(targetFile);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1) {
      throw new StepError(errorKey, EXIT.failed);
    }
  } catch (error) {
    if (error instanceof StepError) throw error;
    if (error.code !== 'ENOENT') throw new StepError(errorKey, EXIT.failed);
  }
  try {
    rmSync(partialFile, { force: true });
    writePrivateText(partialFile, JSON.stringify(record));
    renameSync(partialFile, targetFile);
  } catch {
    rmSync(partialFile, { force: true });
    throw new StepError(errorKey, EXIT.failed);
  }
}

function writeConfirmationState(backupDir, record) {
  const { stateFile, partialFile } = confirmationPaths(backupDir);
  writeAtomicMetaJson(backupDir, stateFile, partialFile, record, 'confirmState');
}

function writeRecipientPolicy(backupDir, record) {
  const { policyFile, partialFile } = recipientPolicyPaths(backupDir);
  writeAtomicMetaJson(backupDir, policyFile, partialFile, record, 'recipientPolicy');
}

export function clearConfirmationState(backupDir) {
  const { stateFile, partialFile } = confirmationPaths(backupDir);
  rmSync(partialFile, { force: true });
  rmSync(stateFile, { force: true });
}

// Records explicit operator confirmation under the shared backup lock and Git guard.
// Never connects to any database, never reads private keys, and never deletes any copy.
export function confirmEncryptedRestore({
  config,
  lock,
  fileName,
  expectedSha256,
  now = () => new Date(),
  env = process.env,
  projectRoot = REPO_ROOT,
}) {
  const targetPaths = confirmationTargetPaths(config.backupDir);
  const gitCheck = verifyBackupDirGitIgnored({
    backupDir: config.backupDir,
    gitBin: config.gitBin,
    env,
    timeoutMs: config.dockerTimeoutMs,
    projectRoot,
    targetPaths,
  });
  if (!gitCheck.ok) {
    return reportFailure(config, gitCheck.key, gitCheck.exit, now);
  }
  if (
    (gitCheck.repoRoot && isInsidePath(canonicalPath(config.statusFile), gitCheck.repoRoot)) ||
    (gitCheck.projectTopLevel &&
      isInsidePath(canonicalPath(config.statusFile), gitCheck.projectTopLevel))
  ) {
    return reportFailure(config, 'notIgnored', EXIT.failed, now);
  }

  if (!lock?.held()) return reportBusy(config, now);

  let saved = false;
  let result;
  try {
    const normalizedExpected =
      typeof expectedSha256 === 'string' ? expectedSha256.trim().toLowerCase() : '';
    if (!SHA256_HEX.test(normalizedExpected)) {
      throw new StepError('confirmDigestMismatch', EXIT.failed);
    }
    readConfirmationState(config.backupDir);
    const existingPolicy = readRecipientPolicy(config.backupDir);
    const entries = listBackups(config.backupDir);
    const artifact = inspectEncryptedArtifact(config.backupDir, fileName);
    if (artifact.sha256 !== normalizedExpected) {
      throw new StepError('confirmDigestMismatch', EXIT.failed);
    }
    if (
      existingPolicy &&
      (!artifact.recipientSha256 || artifact.recipientSha256 !== existingPolicy.recipientSha256)
    ) {
      throw new StepError('recipientMismatch', EXIT.failed);
    }
    if (hasNewerPlainCopy(entries, artifact.time, artifact.file)) {
      throw new StepError('confirmStale', EXIT.failed);
    }
    const confirmedAt = now().toISOString();
    const record = {
      version: 1,
      file: artifact.file,
      confirmedAt,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      metaSha256: artifact.metaSha256,
      createdAt: artifact.createdAt,
      ...(artifact.recipientSha256 ? { recipientSha256: artifact.recipientSha256 } : {}),
    };
    if (!lock.held()) throw new StepError('busy', EXIT.busy);
    if (artifact.recipientSha256) {
      writeRecipientPolicy(config.backupDir, {
        version: 1,
        recipientSha256: artifact.recipientSha256,
        confirmedAt,
        file: artifact.file,
        sha256: artifact.sha256,
      });
    }
    writeConfirmationState(config.backupDir, record);
    saved = true;
    result = {
      ok: true,
      file: artifact.file,
      confirmFile: artifact.file,
      confirmedAt,
      sha256: artifact.sha256,
    };
  } catch (error) {
    result =
      error instanceof StepError
        ? { ok: false, key: error.key, exit: error.exit }
        : { ok: false, key: 'internal', exit: EXIT.failed };
  }

  return report(config, now, result, saved);
}
