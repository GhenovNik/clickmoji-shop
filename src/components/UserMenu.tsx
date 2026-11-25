'use client';

import { useSession, signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { User } from 'lucide-react';
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
      <div className="flex items-center gap-2 sm:gap-3">
        <LanguageSwitcher />
        <Link
          href="/login"
          className="text-xs sm:text-sm text-gray-600 hover:text-gray-900 transition-colors whitespace-nowrap"
        >
          {t('nav.login')}
        </Link>
        <Link
          href="/register"
          className="text-xs sm:text-sm bg-blue-600 hover:bg-blue-700 text-white px-2.5 sm:px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
        >
          {t('nav.register')}
        </Link>
      </div>
    );
  }

  const isAdmin = session.user?.role === 'ADMIN';

  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <LanguageSwitcher />
      {isAdmin && (
        <Link
          href="/admin"
          className="text-xs sm:text-sm bg-purple-600 hover:bg-purple-700 text-white px-2 sm:px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
        >
          {t('nav.admin')}
        </Link>
      )}
      <Link
        href="/account"
        aria-label={t('nav.account')}
        className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-gray-700 hover:text-primary transition-colors whitespace-nowrap"
      >
        <User className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="hidden md:inline max-w-[160px] truncate">
          {session.user?.name || session.user?.email || t('nav.account')}
        </span>
        <span className="md:hidden">{t('nav.account')}</span>
      </Link>
      <button
        onClick={() => signOut({ callbackUrl: '/' })}
        className="text-xs sm:text-sm text-red-600 hover:text-red-700 transition-colors whitespace-nowrap"
      >
        {t('nav.logout')}
      </button>
    </div>
  );
}
