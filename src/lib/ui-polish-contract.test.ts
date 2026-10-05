import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchRemotePattern } from 'next/dist/shared/lib/match-remote-pattern';
import nextConfig from '../../next.config';

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('UI polish contract', () => {
  it('sets Russian document language and keeps page text selectable', () => {
    const globalStyles = read('src/app/globals.css');

    expect(read('src/app/layout.tsx')).toContain('<html lang="ru">');
    expect(globalStyles).not.toMatch(/body\s*\{[\s\S]*select-none/);
    expect(globalStyles).toMatch(/body\s*\{[\s\S]*user-select:\s*text/);
    expect(globalStyles).toMatch(/body\s*\{[\s\S]*-webkit-user-select:\s*text/);
  });

  it('defines xs as a real Tailwind screen breakpoint', () => {
    expect(read('tailwind.config.ts')).toMatch(/screens:\s*\{[\s\S]*xs:\s*["']375px["']/);
  });

  it('allows optimized UploadThing images', () => {
    const expectedRemotePatterns = [
      {
        protocol: 'https',
        hostname: 'utfs.io',
        port: '',
        pathname: '/f/*',
        search: '',
      },
    ];
    const remotePatterns = nextConfig.images?.remotePatterns;
    expect(remotePatterns).toEqual(expectedRemotePatterns);
    const pattern = remotePatterns?.[0];
    if (!pattern) throw new Error('expected exactly one remotePattern');

    const allowed = [
      'https://utfs.io/f/abc123.png',
      'https://utfs.io/f/abc123.png/',
      'https://utfs.io:443/f/abc123.png',
      'https://utfs.io/f/abc123.png?',
      'https://utfs.io/f/abc123.png#x',
      'https://utfs.io/f/a%2Fb',
    ];
    const denied = [
      'http://utfs.io/f/a',
      'https://utfs.io:8443/f/a',
      'https://utfs.io/f/a?x=1',
      'https://utfs.io/x/a',
      'https://utfs.io/f/a/b',
      'https://utfs.io/f/',
      'https://utfs.io/',
      'https://abc.ufs.sh/f/a',
      'https://ufs.sh/f/a',
      'https://utfsXio/f/a',
      'https://evil.example/f/a',
    ];
    for (const src of allowed) {
      expect(matchRemotePattern(pattern, new URL(src)), src).toBe(true);
    }
    for (const src of denied) {
      expect(matchRemotePattern(pattern, new URL(src)), src).toBe(false);
    }
  });

  it('uses next/image on user-facing custom image surfaces', () => {
    const imageFiles = [
      'src/app/categories/page.tsx',
      'src/app/categories/[categoryId]/products/page.tsx',
      'src/app/history/page.tsx',
      'src/components/FavoritesSection.tsx',
      'src/components/ProductSearch.tsx',
      'src/components/favorites/FavoriteCard.tsx',
      'src/components/products/ProductCard.tsx',
      'src/components/shopping/ShoppingListItem.tsx',
    ];

    for (const file of imageFiles) {
      const source = read(file);
      expect(source, file).toContain("from 'next/image'");
      expect(source, file).not.toContain('<img');
    }
  });
});
