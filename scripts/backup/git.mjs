// Git safety checks for the backup destination and temporary directory.
// Resolves physical paths (through any symlinks), verifies project identity and distinguishes
// the real main checkout from linked T3 worktrees, and runs git check-ignore on every exact
// physical file path (temporary and final, including metadata) before writing or publishing.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BACKUP_ENCRYPTED_SUFFIX,
  BACKUP_PLAIN_SUFFIX,
  BACKUP_PREFIX,
  DOCKER_TIMEOUT_MS,
  ENCRYPTED_CONFIRM_STATE_NAME,
  EXIT,
  LEDGER_NAME,
  LOCK_NAME,
  META_DIR,
  PROJECT_NAME,
  REPO_ROOT,
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

// Confirms that checkoutRoot belongs to this project by reading its non-symlinked package.json.
function hasConfirmedProjectIdentity(checkoutRoot) {
  const pkgPath = path.join(checkoutRoot, 'package.json');
  try {
    const lstat = lstatSync(pkgPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg?.name === PROJECT_NAME;
  } catch {
    return false;
  }
}

// Checks whether dir/.git is a real git directory (main checkout) rather than a .git file (linked worktree).
function hasMainGitDirectory(checkoutRoot) {
  try {
    const stat = lstatSync(path.join(checkoutRoot, '.git'));
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

// Classifies an existing directory inside or outside any git repository.
// Returns { ok: true, inRepo: false } when outside git,
// { ok: true, inRepo: true, repoRoot, gitDir, gitCommonDir } when inside a work tree,
// or { ok: false, key, exit } on git failure or .git internals.
function inspectWorkTreeDir(dir, { gitBin, env, timeoutMs }) {
  const probe = runGit(
    gitBin,
    ['-C', dir, 'rev-parse', '--is-inside-git-dir', '--is-inside-work-tree'],
    { env, timeoutMs }
  );
  if (probe.error || probe.signal) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }
  if (probe.status === 128 && /not a git repository/i.test(probe.stderr ?? '')) {
    return { ok: true, inRepo: false, repoRoot: null, gitDir: null, gitCommonDir: null };
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

  const top = runGit(
    gitBin,
    ['-C', dir, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'],
    { env, timeoutMs }
  );
  if (top.error || top.signal || top.status !== 0) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }
  const revLines = (top.stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (revLines.length !== 3) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }

  try {
    return {
      ok: true,
      inRepo: true,
      repoRoot: realpathSync(path.resolve(dir, revLines[0])),
      gitDir: realpathSync(path.resolve(dir, revLines[1])),
      gitCommonDir: realpathSync(path.resolve(dir, revLines[2])),
    };
  } catch {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }
}

// Classifies a physical path with respect to any containing git repository.
// Returns { ok: true, inRepo: false, repoRoot: null, physicalPath } when outside git,
// { ok: true, inRepo: true, repoRoot, gitDir, gitCommonDir, physicalPath } when inside a working tree,
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

  const tree = inspectWorkTreeDir(ancestor, { gitBin, env, timeoutMs });
  if (!tree.ok || !tree.inRepo) {
    return tree.ok ? { ...tree, physicalPath } : tree;
  }

  return { ...tree, physicalPath };
}

// Resolves the project's confirmed main checkout from projectRoot (which may be the main checkout
// or a linked worktree). Distinguishes the real main checkout from linked worktrees via
// git-dir === git-common-dir, a directory .git, and worktree list ordering.
export function inspectProjectMainCheckout(
  projectRoot = REPO_ROOT,
  { gitBin = 'git', env = process.env, timeoutMs = DOCKER_TIMEOUT_MS } = {}
) {
  if (!gitAvailable(gitBin, env, timeoutMs)) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }

  let resolvedRoot;
  try {
    resolvedRoot = realpathSync(projectRoot);
  } catch {
    return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }

  const projectTree = inspectWorkTreeDir(resolvedRoot, { gitBin, env, timeoutMs });
  if (!projectTree.ok) {
    return projectTree.key === 'git'
      ? projectTree
      : { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }
  if (!projectTree.inRepo || !hasConfirmedProjectIdentity(projectTree.repoRoot)) {
    return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }

  const list = runGit(gitBin, ['-C', projectTree.repoRoot, 'worktree', 'list', '--porcelain'], {
    env,
    timeoutMs,
  });
  if (list.error || list.signal || list.status !== 0) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }

  const firstStanza = (list.stdout ?? '').split(/\r?\n\r?\n/)[0]?.split(/\r?\n/) ?? [];
  const mainLine = firstStanza.find((line) => line.startsWith('worktree '));
  const isBare = firstStanza.some((line) => line === 'bare');
  if (!mainLine || isBare) {
    return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }

  let mainCheckoutRoot;
  try {
    mainCheckoutRoot = realpathSync(mainLine.slice('worktree '.length).trim());
  } catch {
    return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }

  if (!hasMainGitDirectory(mainCheckoutRoot) || !hasConfirmedProjectIdentity(mainCheckoutRoot)) {
    return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }

  const mainTree = inspectWorkTreeDir(mainCheckoutRoot, { gitBin, env, timeoutMs });
  if (!mainTree.ok) {
    return mainTree.key === 'git'
      ? mainTree
      : { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }
  if (
    !mainTree.inRepo ||
    mainTree.repoRoot !== mainCheckoutRoot ||
    mainTree.gitDir !== mainTree.gitCommonDir ||
    mainTree.gitCommonDir !== projectTree.gitCommonDir
  ) {
    return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }

  return {
    ok: true,
    mainCheckoutRoot,
    gitCommonDir: projectTree.gitCommonDir,
    projectTopLevel: projectTree.repoRoot,
  };
}

// Verifies right before writing/publishing that backupDir is safe with respect to Git and project identity:
// - Git must be available.
// - backupDir must resolve to the physical backups/ directory of the confirmed main checkout of this
//   project (not a linked worktree's backups/, not a foreign repository, and not an external path).
// - If backupDir or backupDir/meta already exists, it must be a real directory (not a symlink or file).
// - Must contain no tracked files, and every physical path written by the backup tool (including exact
//   temporary and final dump/metadata paths when supplied via targetPaths) must be ignored by Git.
export function verifyBackupDirGitIgnored({
  backupDir,
  gitBin = 'git',
  env = process.env,
  timeoutMs = DOCKER_TIMEOUT_MS,
  projectRoot = REPO_ROOT,
  targetPaths = [],
}) {
  const project = inspectProjectMainCheckout(projectRoot, { gitBin, env, timeoutMs });
  if (!project.ok) return project;

  try {
    const lstat = lstatSync(backupDir);
    if (lstat.isSymbolicLink() || !statSync(backupDir).isDirectory()) {
      return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
    }
  }

  const location = inspectGitLocation(backupDir, { gitBin, env, timeoutMs });
  if (!location.ok) return location;
  if (!location.inRepo) {
    return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }

  const { repoRoot, gitDir, gitCommonDir, physicalPath } = location;
  const expectedBackupsDir = path.join(project.mainCheckoutRoot, 'backups');
  if (
    gitCommonDir !== project.gitCommonDir ||
    gitDir !== gitCommonDir ||
    repoRoot !== project.mainCheckoutRoot ||
    !hasMainGitDirectory(repoRoot) ||
    physicalPath !== expectedBackupsDir
  ) {
    return { ok: false, key: 'notMainBackups', exit: EXIT.failed };
  }

  const metaDir = path.join(physicalPath, META_DIR);
  try {
    const metaLstat = lstatSync(metaDir);
    if (metaLstat.isSymbolicLink() || !statSync(metaDir).isDirectory()) {
      return { ok: false, key: 'notIgnored', exit: EXIT.failed };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { ok: false, key: 'notIgnored', exit: EXIT.failed };
    }
  }

  const relDir = path.relative(repoRoot, physicalPath);
  const tracked = runGit(gitBin, ['-C', repoRoot, 'ls-files', '--', relDir], { env, timeoutMs });
  if (tracked.error || tracked.signal || tracked.status !== 0) {
    return { ok: false, key: 'git', exit: EXIT.unavailable };
  }
  if ((tracked.stdout ?? '').trim() !== '') {
    return { ok: false, key: 'notIgnored', exit: EXIT.failed };
  }

  const pathsToCheck = [
    `${physicalPath}/`,
    `${physicalPath}/${META_DIR}/`,
    `${physicalPath}/${LOCK_NAME}`,
    `${physicalPath}/${LEDGER_NAME}`,
    `${physicalPath}/${LEDGER_NAME}.tmp`,
    `${physicalPath}/${BACKUP_PREFIX}probe${BACKUP_PLAIN_SUFFIX}`,
    `${physicalPath}/${BACKUP_PREFIX}probe${BACKUP_ENCRYPTED_SUFFIX}`,
    `${physicalPath}/.partial-${BACKUP_PREFIX}probe${BACKUP_PLAIN_SUFFIX}`,
    `${physicalPath}/.partial-${BACKUP_PREFIX}probe${BACKUP_ENCRYPTED_SUFFIX}`,
    `${physicalPath}/${META_DIR}/${BACKUP_PREFIX}probe${BACKUP_PLAIN_SUFFIX}.json`,
    `${physicalPath}/${META_DIR}/${BACKUP_PREFIX}probe${BACKUP_ENCRYPTED_SUFFIX}.json`,
    `${physicalPath}/${META_DIR}/.partial-${BACKUP_PREFIX}probe${BACKUP_PLAIN_SUFFIX}.json`,
    `${physicalPath}/${META_DIR}/.partial-${BACKUP_PREFIX}probe${BACKUP_ENCRYPTED_SUFFIX}.json`,
    `${physicalPath}/${META_DIR}/${ENCRYPTED_CONFIRM_STATE_NAME}`,
    `${physicalPath}/${META_DIR}/.partial-${ENCRYPTED_CONFIRM_STATE_NAME}`,
  ];

  for (const target of targetPaths) {
    let physicalTarget;
    try {
      physicalTarget = canonicalPath(target);
    } catch {
      return { ok: false, key: 'notIgnored', exit: EXIT.failed };
    }
    if (!isInsidePath(physicalTarget, physicalPath)) {
      return { ok: false, key: 'notIgnored', exit: EXIT.failed };
    }
    pathsToCheck.push(physicalTarget);
  }

  for (const target of pathsToCheck) {
    const check = runGit(gitBin, ['-C', repoRoot, 'check-ignore', '-q', '--', target], {
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

  return {
    ok: true,
    inRepo: true,
    repoRoot,
    physicalPath,
    mainCheckoutRoot: project.mainCheckoutRoot,
    projectTopLevel: project.projectTopLevel,
  };
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
