import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CYRILLIC = /[\u0400-\u04ff]/;
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function listCodeFiles(relativeDirectory: string): string[] {
  const absoluteDirectory = path.join(process.cwd(), relativeDirectory);

  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      return listCodeFiles(relativePath);
    }

    return CODE_EXTENSIONS.has(path.extname(entry.name)) ? [relativePath] : [];
  });
}

describe('public showcase contract', () => {
  it('keeps the root README English-only and documents localization honestly', () => {
    const readme = read('README.md');
    const localization = read('docs/localization.md');

    expect(readme).not.toMatch(CYRILLIC);
    expect(readme).toContain('English by default');
    expect(readme).toContain('current application UI is Russian-first');
    expect(localization).toContain('Default locale: `en`');
    expect(localization).toContain('Supported locales: `en` and `ru`');
  });

  it('keeps source comments in English while user-facing Russian copy remains allowed', () => {
    const sourceFiles = ['src', 'scripts', 'prisma'].flatMap(listCodeFiles);
    const violations = sourceFiles.flatMap((file) => {
      const comments = read(file).match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
      return comments
        .filter((comment) => CYRILLIC.test(comment))
        .map((comment) => ({ file, comment }));
    });

    expect(violations).toEqual([]);
  });

  it('keeps PWA and discovery assets outside the authentication boundary', () => {
    const proxy = read('src/proxy.ts');

    for (const asset of [
      '/manifest.json',
      '/sw.js',
      '/offline.html',
      '/icon.svg',
      '/robots.txt',
      '/sitemap.xml',
    ]) {
      expect(proxy).toContain(`'${asset}'`);
    }
  });

  it('keeps public quality commands executable and documented', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      engines: Record<string, string>;
    };
    const ciWorkflow = read('.github/workflows/ci.yml');
    const readme = read('README.md');

    expect(packageJson.scripts['format:check']).toBe('prettier --check .');
    expect(packageJson.scripts['test:ui']).toBe('vitest --ui');
    expect(packageJson.scripts['test:coverage']).toBe('vitest --coverage');
    expect(packageJson.scripts.verify).toContain('npm run build');
    expect(packageJson.engines.node).toBe('24.x');
    expect(read('.nvmrc').trim()).toBe('24');
    expect(ciWorkflow).toContain('node-version: 24');
    expect(readme).toContain('- Node.js 24');
  });

  it('removes unused upload surfaces and raw provider errors from public APIs', () => {
    const uploadRouter = read('src/app/api/uploadthing/core.ts');
    const uploadRoute = read('src/app/api/uploadthing/route.ts');
    const aiRoutes = [
      'src/app/api/emoji/generate/route.ts',
      'src/app/api/products/smart-create/route.ts',
      'src/app/api/products/bulk-import/route.ts',
      'src/app/api/lists/import-text/route.ts',
    ].map(read);

    expect(uploadRouter).not.toContain('userAvatar');
    expect(uploadRoute).not.toContain('console.log');
    expect(uploadRoute).not.toContain('Object.getOwnPropertyNames');
    for (const route of aiRoutes) {
      expect(route).not.toContain('details: error instanceof Error');
    }
  });
});
