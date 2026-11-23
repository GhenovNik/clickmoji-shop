import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/app/globals.css', 'utf8');
const modals = [
  'shopping/ImportListModal',
  'products/AddProductModal',
  'lists/CreateListModal',
  'products/VariantMenu',
  'admin/products/BulkImportModal',
  'admin/categories/ProductMoveModal',
];

describe('shared mobile modal layout contract', () => {
  it('has a single modal layer token strictly above mobile navigation', () => {
    const modal = css.match(/--z-modal:\s*(\d+)/);
    const navigation = css.match(/--z-mobile-nav:\s*(\d+)/);
    expect(modal, 'Declare the shared modal z-index token').not.toBeNull();
    expect(navigation, 'Declare the navigation layer token').not.toBeNull();
    expect(Number(modal?.[1])).toBeGreaterThan(Number(navigation?.[1]));
    expect(css).toContain('z-index: var(--z-modal)');
    expect(readFileSync('src/components/layout/MobileNav.tsx', 'utf8')).toContain(
      'z-(--z-mobile-nav)'
    );
  });

  it('bounds the overlay by dvh with a vh fallback and keeps the safe footer out of scrolling', () => {
    expect(css).toMatch(/height: 100vh;[\s\S]*height: 100dvh;/);
    expect(css).toMatch(/\.modal-body\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
    expect(css).toMatch(/\.modal-footer\s*\{[^}]*flex-shrink: 0;/);
    expect(css).toContain('env(safe-area-inset-bottom');
  });

  it.each(modals)('%s uses the common Modal and non-scrolling footer', (modal) => {
    const source = readFileSync(`src/components/${modal}.tsx`, 'utf8');
    expect(source).toContain("from '@/components/ui/Modal'");
    expect(source).toContain('<Modal');
    expect(source).toContain('<ModalBody');
    expect(source).toContain('<ModalFooter');
    expect(source).not.toMatch(/z-50|z-\[60\]|90vh|fixed inset-0/);
  });
});
