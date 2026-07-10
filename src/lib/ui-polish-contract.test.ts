import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
    const nextConfig = read('next.config.ts');
    expect(nextConfig).toContain('remotePatterns');
    expect(nextConfig).toContain('utfs.io');
    expect(nextConfig).toContain('ufs.sh');
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
