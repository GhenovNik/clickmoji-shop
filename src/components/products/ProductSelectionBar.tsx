'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

interface ProductSelectionBarProps {
  count: number;
  adding: boolean;
  error?: string;
  onAddToList: () => void;
  isAuthenticated: boolean;
}

export default function ProductSelectionBar({
  count,
  adding,
  error,
  onAddToList,
  isAuthenticated,
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
          <Link
            href="/login"
            className="bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-3 rounded-xl font-semibold transition-colors shadow-md"
          >
            {t('signInToAdd')}
          </Link>
        )}
      </div>
    </div>
  );
}
