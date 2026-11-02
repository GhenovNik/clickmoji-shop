'use client';

import { useSession, signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import LanguageSwitcher from '@/components/LanguageSwitcher';

export default function UserMenu() {
  const { data: session, status } = useSession();
  const t = useTranslations();

  if (status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-gray-500">
        <LanguageSwitcher />
        <span className="text-sm">{t('common.loading')}</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center gap-3">
        <LanguageSwitcher />
        <Link href="/login" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
          {t('nav.login')}
        </Link>
        <Link
          href="/register"
          className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          {t('nav.register')}
        </Link>
      </div>
    );
  }

  const isAdmin = session.user?.role === 'ADMIN';

  return (
    <div className="flex items-center gap-3">
      <LanguageSwitcher />
      {isAdmin && (
        <Link
          href="/admin"
          className="text-sm bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          {t('nav.admin')}
        </Link>
      )}
      <span className="text-sm text-gray-700">{session.user?.name || session.user?.email}</span>
      <button
        onClick={() => signOut({ callbackUrl: '/' })}
        className="text-sm text-red-600 hover:text-red-700 transition-colors"
      >
        {t('nav.logout')}
      </button>
    </div>
  );
}
