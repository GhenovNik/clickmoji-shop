// Git safety checks for the backup destination and temporary directory.
// Resolves the physical path (through any symlinks) and runs git in the destination
// repository regardless of the caller's working directory, so running from a worktree
// still checks the main checkout's .gitignore rules.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BACKUP_ENCRYPTED_SUFFIX,
  BACKUP_PLAIN_SUFFIX,
  BACKUP_PREFIX,
  DOCKER_TIMEOUT_MS,
  EXIT,
  LEDGER_NAME,
  LOCK_NAME,
  META_DIR,
} from './constants.mjs';

const GIT_ENV_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_SUPER_PREFIX',
];

export function cleanGitEnv(env = process.env) {
  const cleaned = {};
  for (const [key, value] of Object.entries(env)) {
    if (!GIT_ENV_OVERRIDES.includes(key)) cleaned[key] = value;
  }
  return cleaned;
}

export function isInsidePath(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Physical path with every symlink on existing ancestors resolved; non-existent trailing
// segments are kept as normalized names.
export function canonicalPath(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== 'ENOENT' || parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function nearestExistingDir(target) {
  let current = path.resolve(target);
  for (;;) {
    if (existsSync(current)) {
      try {
        return statSync(current).isDirectory() ? realpathSync(current) : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function hasGitSegment(targetPath) {
  return path.resolve(targetPath).split(path.sep).includes('.git');
}

function runGit(gitBin, args, { cwd, env, timeoutMs }) {
  return spawnSync(gitBin, args, {
    cwd,
    env: cleanGitEnv(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
}

function gitAvailable(gitBin, env, timeoutMs) {
  const result = runGit(gitBin, ['--version'], { env, timeoutMs });
  return (
    !result.error &&
    !result.signal &&
    result.status === 0 &&
    /^git version /.test((result.stdout ?? '').trim())
  );
}

// Classifies a physical path with respect to any containing git repository.
// Returns { ok: true, inRepo: false, repoRoot: null, physicalPath } when outside git,
// { ok: true, inRepo: true, repoRoot, physicalPath } when inside a working tree,
// or { ok: false, key, exit } on unavailable git, invalid directory, or .git internals.
function inspectGitLocation(
  targetPath,
  { gitBin = 'git', env = process.env, timeoutMs = DOCKER_TIMEOUT_MS } = {}
) {
  if (!gitAvailable(gitBin, env, timeoutMs)) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }

  let physicalPath;
  try {
    physicalPath = canonicalPath(targetPath);
  } catch {
    return { ok: false, key: 'notIgnored', exit: EXIT.failed };
  }

  if (hasGitSegment(targetPath) || hasGitSegment(physicalPath)) {
    return { ok: false, key: 'notIgnored', exit: EXIT.failed };
  }

  const ancestor = nearestExistingDir(physicalPath);
  if (!ancestor) {
    return { ok: false, key: 'notIgnored', exit: EXIT.failed };
  }

  const probe = runGit(
    gitBin,
    ['-C', ancestor, 'rev-parse', '--is-inside-git-dir', '--is-inside-work-tree'],
    { env, timeoutMs }
  );
  if (probe.error || probe.signal) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }
  if (probe.status === 128 && /not a git repository/i.test(probe.stderr ?? '')) {
    return { ok: true, inRepo: false, repoRoot: null, physicalPath };
  }
  if (probe.status !== 0) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }

  const lines = (probe.stdout ?? '').trim().split(/\r?\n/);
  if (lines.length !== 2) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }
  const [inGitDir, inWorkTree] = lines;
  if (
    (inGitDir !== 'true' && inGitDir !== 'false') ||
    (inWorkTree !== 'true' && inWorkTree !== 'false')
  ) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }
  if (inGitDir === 'true' || inWorkTree !== 'true') {
    return { ok: false, key: 'notIgnored', exit: EXIT.failed };
  }

  const top = runGit(gitBin, ['-C', ancestor, 'rev-parse', '--show-toplevel'], { env, timeoutMs });
  if (top.error || top.signal || top.status !== 0 || !(top.stdout ?? '').trim()) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }
  let repoRoot;
  try {
    repoRoot = realpathSync(top.stdout.trim());
  } catch {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }

  return { ok: true, inRepo: true, repoRoot, physicalPath };
}

// Verifies right before writing that backupDir is safe with respect to Git:
// - If backupDir exists, it must be a directory (not a file, FIFO, or dangling link).
// - Git must be available.
// - If backupDir's physical path is inside a git repository, it must not be the repo root,
//   must not contain tracked files, and every path pattern written by the backup tool must
//   be ignored according to `git check-ignore` in that destination repository.
export function verifyBackupDirGitIgnored({
  backupDir,
  gitBin = 'git',
  env = process.env,
  timeoutMs = DOCKER_TIMEOUT_MS,
}) {
  try {
    lstatSync(backupDir);
    if (!statSync(backupDir).isDirectory()) {
      return { ok: false, key: 'notIgnored', exit: EXIT.failed };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { ok: false, key: 'notIgnored', exit: EXIT.failed };
    }
  }

  const location = inspectGitLocation(backupDir, { gitBin, env, timeoutMs });
  if (!location.ok || !location.inRepo) return location;

  const { repoRoot, physicalPath } = location;
  if (physicalPath === repoRoot || !isInsidePath(physicalPath, repoRoot)) {
    return { ok: false, key: 'notIgnored', exit: EXIT.failed };
  }

  const relDir = path.relative(repoRoot, physicalPath);
  const tracked = runGit(gitBin, ['-C', repoRoot, 'ls-files', '--', relDir], { env, timeoutMs });
  if (tracked.error || tracked.signal || tracked.status !== 0) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }
  if ((tracked.stdout ?? '').trim() !== '') {
    return { ok: false, key: 'notIgnored', exit: EXIT.failed };
  }

  const probes = [
    `${physicalPath}/`,
    `${physicalPath}/${BACKUP_PREFIX}probe${BACKUP_PLAIN_SUFFIX}`,
    `${physicalPath}/${BACKUP_PREFIX}probe${BACKUP_ENCRYPTED_SUFFIX}`,
    `${physicalPath}/${META_DIR}/${BACKUP_PREFIX}probe${BACKUP_PLAIN_SUFFIX}.json`,
    `${physicalPath}/${META_DIR}/${BACKUP_PREFIX}probe${BACKUP_ENCRYPTED_SUFFIX}.json`,
    `${physicalPath}/${LOCK_NAME}`,
    `${physicalPath}/${LEDGER_NAME}`,
  ];
  for (const probe of probes) {
    const check = runGit(gitBin, ['-C', repoRoot, 'check-ignore', '-q', '--', probe], {
      env,
      timeoutMs,
    });
    if (check.error || check.signal) {
      return { ok: false, key: 'git', exit: EXIT.unavailable };
    }
    if (check.status === 1) {
      return { ok: false, key: 'notIgnored', exit: EXIT.failed };
    }
    if (check.status !== 0) {
      return { ok: false, key: 'git', exit: EXIT.unavailable };
    }
  }

  return { ok: true, inRepo: true, repoRoot, physicalPath };
}

// Returns true when targetPath resolves inside any git repository (worktree or .git directory)
// or when Git itself cannot answer (fail closed for temporary plaintext storage).
export function isTempRootUnsafeForGit(
  targetPath,
  { gitBin = 'git', env = process.env, timeoutMs = DOCKER_TIMEOUT_MS } = {}
) {
  const location = inspectGitLocation(targetPath, { gitBin, env, timeoutMs });
  if (!location.ok) return true;
  return location.inRepo;
}
