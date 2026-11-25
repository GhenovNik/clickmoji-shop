import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { imageConfigDefault } from 'next/dist/shared/lib/image-config';
import { ImageConfigContext } from 'next/dist/shared/lib/image-config-context.shared-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import { messages } from '@/i18n/messages';
import type { Locale } from '@/i18n/config';

const { getLocaleMock, pushMock, refreshMock, updateSessionMock, useSessionMock } = vi.hoisted(
  () => ({
    getLocaleMock: vi.fn<() => Promise<Locale>>(async () => 'ru'),
    pushMock: vi.fn(),
    refreshMock: vi.fn(),
    updateSessionMock: vi.fn(async () => null),
    useSessionMock: vi.fn<
      () => {
        data: { user?: { id: string } } | null;
        status: string;
        update: () => Promise<null>;
      }
    >(),
  })
);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

vi.mock('next-auth/react', () => ({
  useSession: useSessionMock,
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
    pushMock.mockReset();
    refreshMock.mockReset();
    updateSessionMock.mockReset().mockResolvedValue(null);
    useSessionMock.mockReset().mockReturnValue({
      data: null,
      status: 'unauthenticated',
      update: updateSessionMock,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      expect(screen.queryAllByRole('link')).toHaveLength(0);
      const startButton = screen.getByRole('button', { name: startLabel });
      expect(startButton).toBeInTheDocument();

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

  it('creates a server guest session on Start click and navigates to categories', async () => {
    getLocaleMock.mockResolvedValue('en');
    const fetchMock = vi.fn(async () =>
      Response.json({ user: { id: 'guest-1', role: 'USER', isGuest: true } }, { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ImageConfigContext.Provider value={{ ...imageConfigDefault, ...nextConfig.images }}>
        {await Home()}
      </ImageConfigContext.Provider>
    );

    const startButton = screen.getByRole('button', { name: 'Start' });
    fireEvent.click(startButton);
    fireEvent.click(startButton);

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/categories'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/guest', { method: 'POST' });
    expect(updateSessionMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('navigates directly to categories without calling /api/auth/guest when already signed in', async () => {
    getLocaleMock.mockResolvedValue('ru');
    useSessionMock.mockReturnValue({
      data: { user: { id: 'existing-user' } },
      status: 'authenticated',
      update: updateSessionMock,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ImageConfigContext.Provider value={{ ...imageConfigDefault, ...nextConfig.images }}>
        {await Home()}
      </ImageConfigContext.Provider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Начать' }));

    expect(pushMock).toHaveBeenCalledWith('/categories');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a localized alert and stays on / when guest session creation fails', async () => {
    getLocaleMock.mockResolvedValue('en');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'Too many attempts. Please try again later.' }, { status: 429 })
      )
    );

    render(
      <ImageConfigContext.Provider value={{ ...imageConfigDefault, ...nextConfig.images }}>
        {await Home()}
      </ImageConfigContext.Provider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Please try again later.'
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

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
