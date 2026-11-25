import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repository root derived from this module's location, so the guards do not depend on the cwd.
export const TOOL_REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const MAX_SYMLINK_HOPS = 64;

// Canonical absolute path: symlinks are followed in every existing component, and the components
// that do not exist yet are appended to the canonical form of their nearest existing ancestor.
// A dangling symlink is followed to its target, so a link into the repo is seen as a path into the repo.
export function canonicalPath(target: string): string {
  let current = resolve(target);
  const tail: string[] = [];
  for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops++) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      // Missing component or dangling symlink: handled below.
    }
    const parent = dirname(current);
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      isLink = false;
    }
    if (isLink) {
      current = resolve(parent, readlinkSync(current));
      continue;
    }
    if (parent === current) return join(current, ...tail.reverse());
    tail.push(basename(current));
    current = parent;
  }
  throw new Error(`Слишком много переходов по символьным ссылкам: ${resolve(target)}`);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Downloaded catalogue images and audit outputs must live outside the repository checkout.
// The check uses canonical paths, so an alias or a dangling link into the checkout is refused
// before anything is created.
export function assertPathOutsideRepo(targetPath: string, repoRoot = TOOL_REPO_ROOT): void {
  const canonicalTarget = canonicalPath(targetPath);
  const canonicalRepo = canonicalPath(repoRoot);
  if (isInside(canonicalRepo, canonicalTarget)) {
    throw new Error(
      `Refusing path inside repository "${resolve(targetPath)}" (канонический путь ${canonicalTarget}): downloaded catalog images and audit outputs must live outside the repo`
    );
  }
}

export function assertAuditOutputPath(targetPath: string): void {
  assertPathOutsideRepo(targetPath);
  const entry = lstatSync(targetPath, { throwIfNoEntry: false });
  if (entry && (!entry.isFile() || entry.nlink > 1)) {
    throw new Error(`Refusing linked or non-file audit output "${targetPath}"`);
  }
}

// Checked before the first write. The input folder and the output folder must be different
// directories, and no planned output name may be a symlink or the same file as an input.
export function assertOutputsSeparate(options: {
  inputDir: string;
  outDir: string;
  inputFiles?: string[];
  outputNames: string[];
}): void {
  const realIn = canonicalPath(options.inputDir);
  const realOut = canonicalPath(options.outDir);
  if (realIn === realOut) {
    throw new Error(
      `Выходная папка совпадает со входной (${realIn}): исходные сетки не перезаписываются, укажите другой --out`
    );
  }

  const identities = new Set<string>();
  const addSource = (path: string) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return; // A broken entry cannot be read as a source and cannot be overwritten through this check.
    }
    if (stat.isFile()) identities.add(`${stat.dev}:${stat.ino}`);
  };
  if (existsSync(options.inputDir)) {
    for (const name of readdirSync(options.inputDir)) addSource(join(options.inputDir, name));
  }
  for (const file of options.inputFiles ?? []) addSource(file);

  for (const name of options.outputNames) {
    const path = join(realOut, name);
    let link;
    try {
      link = lstatSync(path);
    } catch {
      continue; // Nothing there yet: the write creates a new file.
    }
    if (link.isSymbolicLink()) {
      throw new Error(`Выходной путь ${path} — символьная ссылка: запись пошла бы по ней, отказ`);
    }
    const stat = statSync(path);
    if (identities.has(`${stat.dev}:${stat.ino}`)) {
      throw new Error(
        `Выходной файл ${path} — та же запись на диске, что и исходная картинка (жёсткая ссылка): отказ, исходники не трогаем`
      );
    }
  }
}
