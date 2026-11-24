import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { imageConfigDefault } from 'next/dist/shared/lib/image-config';
import { ImageConfigContext } from 'next/dist/shared/lib/image-config-context.shared-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import { messages } from '@/i18n/messages';
import type { Locale } from '@/i18n/config';

const { getLocaleMock } = vi.hoisted(() => ({
  getLocaleMock: vi.fn<() => Promise<Locale>>(async () => 'ru'),
}));

vi.mock('next-intl/server', () => ({
  getLocale: getLocaleMock,
  getTranslations: async (namespace: keyof (typeof messages)['ru']) => {
    const locale = await getLocaleMock();
    return createTranslator({
      locale,
      messages: messages[locale],
      namespace,
    });
  },
}));

import Home from './page';

describe('Home landing page', () => {
  beforeEach(() => {
    getLocaleMock.mockReset();
  });

  for (const locale of ['ru', 'en'] as const) {
    it(`renders single Start CTA and 3 localized product UI screenshots in ${locale}`, async () => {
      getLocaleMock.mockResolvedValue(locale);
      render(
        <ImageConfigContext.Provider value={{ ...imageConfigDefault, ...nextConfig.images }}>
          {await Home()}
        </ImageConfigContext.Provider>
      );

      const startLabel = locale === 'ru' ? 'Начать' : 'Start';
      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAccessibleName(startLabel);
      expect(links[0]).toHaveAttribute('href', '/categories');

      for (const oldText of [
        /Открыть каталог|Open catalog/i,
        /Мои списки|My lists/i,
        /История покупок|Purchase history/i,
        /Умные списки|Smart lists/i,
        /Избранное|Favorites/i,
      ]) {
        expect(screen.queryByText(oldText)).not.toBeInTheDocument();
      }

      const images = screen.getAllByRole('img');
      expect(images).toHaveLength(3);
      expect(images[0]).toHaveAttribute('loading', 'eager');
      expect(images[0]).toHaveAttribute('fetchpriority', 'high');
      expect(images[1]).toHaveAttribute('loading', 'lazy');
      expect(images[2]).toHaveAttribute('loading', 'lazy');

      const expectedKeys = ['cards', 'list', 'grid'] as const;
      expectedKeys.forEach((key, index) => {
        const expected = messages[locale].home.showcase[key];
        expect(images[index]).toHaveAttribute('alt', expected.alt);
        expect(screen.getByRole('heading', { name: expected.title })).toBeInTheDocument();
        expect(screen.getByText(expected.caption)).toBeInTheDocument();
      });
    });
  }

  it('ships all RU and EN landing screenshot assets and uses next/image without raw img tags', () => {
    for (const locale of ['ru', 'en'] as const) {
      for (const file of ['product-cards.webp', 'shopping-list.webp', 'shopping-grid.webp']) {
        const fullPath = path.join(process.cwd(), 'src/assets/landing', locale, file);
        expect(existsSync(fullPath), fullPath).toBe(true);
      }
    }

    const showcaseSource = readFileSync(
      path.join(process.cwd(), 'src/components/landing/ProductShowcase.tsx'),
      'utf8'
    );
    expect(showcaseSource).toContain("from 'next/image'");
    expect(showcaseSource).not.toContain('<img');
    expect(nextConfig.images?.formats).toEqual(['image/avif', 'image/webp']);
  });
});
