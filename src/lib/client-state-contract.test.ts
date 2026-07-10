import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.join(process.cwd(), 'src');
const sourceExtensions = new Set(['.ts', '.tsx']);

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      return listSourceFiles(fullPath);
    }

    if (!sourceExtensions.has(path.extname(fullPath)) || fullPath.endsWith('.test.ts')) {
      return [];
    }

    return [fullPath];
  });
}

function filesContaining(pattern: RegExp) {
  return listSourceFiles(sourceRoot)
    .filter((filePath) => pattern.test(readFileSync(filePath, 'utf8')))
    .map((filePath) => path.relative(process.cwd(), filePath));
}

describe('client server-state ownership contract', () => {
  it('does not keep server-backed shopping lists in Zustand or localStorage', () => {
    expect(existsSync(path.join(sourceRoot, 'store/shopping-list.ts'))).toBe(false);
    expect(filesContaining(/shopping-list-storage|@\/store\/shopping-list/)).toEqual([]);
    expect(filesContaining(/\bsetLists\b|\bgetActiveList\b|useLists\.getState\(/)).toEqual([]);
  });
});
