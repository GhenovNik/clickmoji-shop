// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_REPO_ROOT } from './safe-paths';

// AGE-1667 C3 (B1, B2): the C3 preview is offline and cannot overwrite its sources.
// The CLI runs with a synthetic DATABASE_URL to a closed local port: the preview must never connect.

const TSX_CLI = resolve(TOOL_REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const IMPORT_CLI = resolve(TOOL_REPO_ROOT, 'scripts/emoji-import.ts');
const SYNTHETIC_DSN = 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function greenPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 128,
      height: 128,
      channels: 4,
      background: { r: 67, g: 160, b: 71, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

function runImport(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [TSX_CLI, IMPORT_CLI, ...args], {
    cwd: TOOL_REPO_ROOT,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

function envWithout(name: string | undefined, overrides: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  if (name) delete env[name];
  return env;
}

describe('C3 preview-only does not open the catalogue (AGE-1667 C3 B1)', () => {
  it(
    'ignores an inherited DATABASE_URL without --check-catalog and exits as a preview',
    { timeout: 120_000 },
    async () => {
      const dir = makeTempDir('c3-b1-preview-');
      writeFileSync(join(dir, 'batch-001-1.png'), await greenPng());
      const out = join(dir, 'preview');
      const result = runImport(
        ['--dir', dir, '--batch', '001', '--out', out],
        envWithout(undefined, { DATABASE_URL: SYNTHETIC_DSN })
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('каталог не проверялся (C3 preview-only');
      expect(result.stdout).toContain('флагом --check-catalog');
      expect(result.stdout).not.toMatch(/ECONNREFUSED|Can't reach|PrismaClient/);
      expect(existsSync(join(out, 'preview.html'))).toBe(true);
    }
  );

  it(
    'fails closed when --check-catalog is requested without DATABASE_URL',
    { timeout: 120_000 },
    () => {
      const dir = makeTempDir('c3-b1-closed-');
      const result = runImport(
        ['--dir', dir, '--batch', '001', '--out', join(dir, 'preview'), '--check-catalog'],
        envWithout('DATABASE_URL')
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--check-catalog needs DATABASE_URL');
      expect(existsSync(join(dir, 'preview'))).toBe(false);
    }
  );
});

describe('the output folder never overwrites its sources (AGE-1667 C3 B2)', () => {
  it('refuses an equal folder and keeps the source bytes', { timeout: 120_000 }, () => {
    const dir = makeTempDir('c3-b2-equal-');
    const source = join(dir, 'batch-001-1.webp');
    const bytes = Buffer.from('synthetic-source-bytes');
    writeFileSync(source, bytes);
    const result = runImport(['--dir', dir, '--batch', '001', '--out', dir], envWithout(undefined));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('совпадает со входной');
    expect(readFileSync(source).equals(bytes)).toBe(true);
  });

  it(
    'refuses an equivalent folder reached through a symlink and keeps the source bytes',
    { timeout: 120_000 },
    () => {
      const dir = makeTempDir('c3-b2-alias-');
      const alias = join(makeTempDir('c3-b2-alias-link-'), 'alias');
      symlinkSync(dir, alias, 'dir');
      const source = join(dir, 'batch-001-1.webp');
      const bytes = Buffer.from('synthetic-source-bytes');
      writeFileSync(source, bytes);
      const result = runImport(
        ['--dir', dir, '--batch', '001', '--out', alias],
        envWithout(undefined)
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('совпадает со входной');
      expect(readFileSync(source).equals(bytes)).toBe(true);
    }
  );

  it(
    'refuses a hard link in the output folder that is the same file as a source',
    { timeout: 120_000 },
    () => {
      const dir = makeTempDir('c3-b2-hardlink-');
      const out = makeTempDir('c3-b2-hardlink-out-');
      const source = join(dir, 'batch-001-1.webp');
      const bytes = Buffer.from('synthetic-source-bytes');
      writeFileSync(source, bytes);
      linkSync(source, join(out, 'batch-001-1.webp'));
      const result = runImport(
        ['--dir', dir, '--batch', '001', '--out', out],
        envWithout(undefined)
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('жёсткая ссылка');
      expect(readFileSync(source).equals(bytes)).toBe(true);
    }
  );

  it(
    'refuses a symlink at a planned output name and keeps the source bytes',
    { timeout: 120_000 },
    () => {
      const dir = makeTempDir('c3-b2-symlink-');
      const out = makeTempDir('c3-b2-symlink-out-');
      const source = join(dir, 'batch-001-1.webp');
      const bytes = Buffer.from('synthetic-source-bytes');
      writeFileSync(source, bytes);
      symlinkSync(source, join(out, 'batch-001-1.webp'));
      const result = runImport(
        ['--dir', dir, '--batch', '001', '--out', out],
        envWithout(undefined)
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('символьная ссылка');
      expect(readFileSync(source).equals(bytes)).toBe(true);
    }
  );

  it(
    'writes normally into the typical preview subfolder and keeps the source bytes',
    { timeout: 120_000 },
    async () => {
      const dir = makeTempDir('c3-b2-subfolder-');
      const source = join(dir, 'batch-001-1.png');
      const png = await greenPng();
      writeFileSync(source, png);
      const out = join(dir, 'preview');
      mkdirSync(out);
      const result = runImport(
        ['--dir', dir, '--batch', '001', '--out', out],
        envWithout(undefined)
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(out, 'preview.html'))).toBe(true);
      expect(readFileSync(source).equals(png)).toBe(true);
    }
  );
});
