import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Catalogue names are drawn by LocalizedName, which applies the language rule. A raw `nameEn` in
// JSX would show the English line in every language, so the display sites must not render it.
const DISPLAY_SITES = [
  'src/components/products/ProductCard.tsx',
  'src/components/products/VariantMenu.tsx',
  'src/components/favorites/FavoriteCard.tsx',
  'src/components/shopping/ShoppingListItem.tsx',
  'src/components/shopping/ShoppingCategoryGroup.tsx',
  'src/components/ProductSearch.tsx',
  'src/components/admin/products/ProductsTable.tsx',
  'src/components/admin/categories/CategoriesTable.tsx',
  'src/components/admin/categories/ProductMoveModal.tsx',
  'src/app/history/page.tsx',
  'src/app/categories/page.tsx',
  'src/app/categories/[categoryId]/products/page.tsx',
];

describe('catalogue name display sites', () => {
  it.each(DISPLAY_SITES)('%s draws names through LocalizedName', (file) => {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8');

    expect(source).toContain('LocalizedName');
    expect(source).not.toMatch(/\{[\w.]*nameEn\}/);
    expect(source).not.toContain('nameLang');
  });
});
