'use client';

import { useSession, signOut } from 'next-auth/react';
import Link from 'next/link';

export default function UserMenu() {
  const { data: session, status } = useSession();

  if (status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-gray-500">
        <span className="text-sm">Загрузка...</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center gap-3">
        <Link href="/login" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
          Войти
        </Link>
        <Link
          href="/register"
          className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          Регистрация
        </Link>
      </div>
    );
  }

  const isAdmin = session.user?.role === 'ADMIN';

  return (
    <div className="flex items-center gap-3">
      {isAdmin && (
        <Link
          href="/admin"
          className="text-sm bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          Админ-панель
        </Link>
      )}
      <span className="text-sm text-gray-700">{session.user?.name || session.user?.email}</span>
      <button
        onClick={() => signOut({ callbackUrl: '/' })}
        className="text-sm text-red-600 hover:text-red-700 transition-colors"
      >
        Выйти
      </button>
    </div>
  );
}
