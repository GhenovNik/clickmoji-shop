// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheKeyForUrl, createCachingImageLoader, type CatalogImageEntry } from './emoji-detail';
import { runAuditCli } from '../../../scripts/emoji-detail-audit';
import { TOOL_REPO_ROOT, assertPathOutsideRepo } from './safe-paths';

// AGE-1667 C3 (B3): the repo root comes from the tool, not from the cwd; canonical paths of existing
// components (including links and not-yet-created folders) decide. All tests are offline and create
// nothing inside the checkout: a refused path must not appear there.

const tempDirs: string[] = [];
const created = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('repo root and canonical outside-repo guard (AGE-1667 C3 B3)', () => {
  it('locates the checkout from the tool itself', () => {
    expect(existsSync(join(TOOL_REPO_ROOT, 'package.json'))).toBe(true);
  });

  it('keeps the default root when the cwd is outside the checkout', () => {
    const outside = created('c3-cwd-');
    const previous = process.cwd();
    process.chdir(outside);
    try {
      expect(() => assertPathOutsideRepo(join(TOOL_REPO_ROOT, 'guard-cwd-never'))).toThrow(
        'inside repository'
      );
      expect(existsSync(join(TOOL_REPO_ROOT, 'guard-cwd-never'))).toBe(false);
      expect(() => assertPathOutsideRepo(join(outside, 'cache'))).not.toThrow();
    } finally {
      process.chdir(previous);
    }
  });

  it('refuses an ordinary path inside the checkout before anything is created', () => {
    const target = join(TOOL_REPO_ROOT, 'guard-plain-never', 'cache');
    expect(() => assertPathOutsideRepo(target)).toThrow('inside repository');
    expect(existsSync(join(TOOL_REPO_ROOT, 'guard-plain-never'))).toBe(false);
  });

  it('refuses a not-yet-created folder reached through an alias to the checkout', () => {
    const alias = join(created('c3-alias-'), 'alias');
    symlinkSync(join(TOOL_REPO_ROOT, 'src'), alias, 'dir');
    const target = join(alias, 'not-yet', 'cache');
    expect(() => assertPathOutsideRepo(target)).toThrow('inside repository');
    expect(existsSync(join(TOOL_REPO_ROOT, 'src', 'not-yet'))).toBe(false);
  });

  it('refuses a dangling alias that points into the checkout', () => {
    const alias = join(created('c3-dangling-'), 'dangling');
    symlinkSync(join(TOOL_REPO_ROOT, 'guard-dangling-never'), alias);
    expect(() => assertPathOutsideRepo(join(alias, 'cache'))).toThrow('inside repository');
    expect(existsSync(join(TOOL_REPO_ROOT, 'guard-dangling-never'))).toBe(false);
  });

  it('accepts an ordinary external path that does not exist yet and creates nothing', () => {
    const outside = created('c3-external-');
    const target = join(outside, 'plain', 'cache');
    expect(() => assertPathOutsideRepo(target)).not.toThrow();
    expect(existsSync(join(outside, 'plain'))).toBe(false);
  });

  it('refuses an existing report link that points into the checkout', () => {
    const outDir = created('c3-report-');
    symlinkSync(join(TOOL_REPO_ROOT, 'package.json'), join(outDir, 'detail-report.json'));
    expect(() => assertPathOutsideRepo(join(outDir, 'detail-report.json'))).toThrow(
      'inside repository'
    );
  });

  it('audit CLI refuses a cache alias into the checkout before it creates the cache', async () => {
    const outside = created('c3-audit-cli-');
    const alias = join(outside, 'cache-alias');
    symlinkSync(join(TOOL_REPO_ROOT, 'guard-audit-cache-never'), alias);
    await expect(
      runAuditCli([
        '--input',
        join(outside, 'missing-export.json'),
        '--cache-dir',
        join(alias, 'cache'),
        '--offline',
      ])
    ).rejects.toThrow('inside repository');
    expect(existsSync(join(TOOL_REPO_ROOT, 'guard-audit-cache-never'))).toBe(false);
  });

  it('loader refuses a dangling cache link into the checkout and writes nothing there', async () => {
    const cacheDir = created('c3-loader-');
    const url = 'https://cdn.example.test/loader-never.png';
    symlinkSync(join(TOOL_REPO_ROOT, 'guard-loader-never'), join(cacheDir, cacheKeyForUrl(url)));
    let fetched = 0;
    const loadImage = createCachingImageLoader({
      cacheDir,
      fetchImpl: async () => {
        fetched++;
        return new Response(Buffer.from('synthetic-bytes'));
      },
    });
    const entry = { url } as CatalogImageEntry;
    await expect(loadImage(entry)).rejects.toThrow('inside repository');
    expect(fetched).toBe(0);
    expect(existsSync(join(TOOL_REPO_ROOT, 'guard-loader-never'))).toBe(false);
  });

  it('an ordinary cache write outside the checkout still works offline', async () => {
    const cacheDir = created('c3-loader-ok-');
    const url = 'https://cdn.example.test/ok.png';
    const loadImage = createCachingImageLoader({
      cacheDir,
      fetchImpl: async () => new Response(Buffer.from('synthetic-bytes')),
    });
    const bytes = await loadImage({ url } as CatalogImageEntry);
    expect(bytes.toString()).toBe('synthetic-bytes');
    expect(readFileSync(join(cacheDir, cacheKeyForUrl(url)), 'utf8')).toBe('synthetic-bytes');
  });
});
