'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface ProductSelectionBarProps {
  count: number;
  adding: boolean;
  error?: string;
  onAddToList: () => void;
  isAuthenticated: boolean;
  onBeforeLogin?: () => void;
}

// Isolated so the bar never reads the router when the sign-in link is not rendered.
function SignInLink({
  onBeforeLogin,
  className,
  children,
}: {
  onBeforeLogin?: () => void;
  className: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const base = pathname ?? '/';
  const query = searchParams?.toString() ?? '';
  const current = query ? `${base}?${query}` : base;
  const href = `/login?callbackUrl=${encodeURIComponent(current)}`;
  return (
    <Link href={href} onClick={onBeforeLogin} className={className}>
      {children}
    </Link>
  );
}

export default function ProductSelectionBar({
  count,
  adding,
  error,
  onAddToList,
  isAuthenticated,
  onBeforeLogin,
}: ProductSelectionBarProps) {
  const t = useTranslations('catalog.selectionBar');

  if (count === 0) return null;

  return (
    <div className="fixed sm:bottom-0 bottom-16 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg z-40 pb-safe-bottom">
      {error && (
        <p role="alert" className="max-w-4xl mx-auto text-red-500 text-sm mb-2">
          {error}
        </p>
      )}
      <div className="max-w-4xl mx-auto flex items-center justify-between">
        <div className="text-lg font-semibold">{t('selected', { count })}</div>
        {isAuthenticated ? (
          <button
            onClick={onAddToList}
            disabled={adding}
            className="bg-green-500 hover:bg-green-600 text-white px-8 py-3 rounded-xl font-semibold transition-colors disabled:opacity-50 shadow-md"
          >
            {adding ? t('adding') : t('add')}
          </button>
        ) : (
          <SignInLink
            onBeforeLogin={onBeforeLogin}
            className="bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-3 rounded-xl font-semibold transition-colors shadow-md"
          >
            {t('signInToAdd')}
          </SignInLink>
        )}
      </div>
    </div>
  );
}
