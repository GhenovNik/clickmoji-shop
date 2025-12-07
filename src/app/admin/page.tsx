import Link from 'next/link';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function AdminPage() {
  const session = await auth();

  if (!session || session.user.role !== 'ADMIN') {
    redirect('/');
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <Link
            href="/"
            className="text-blue-600 hover:text-blue-700 text-sm mb-4 inline-block"
          >
            ← На главную
          </Link>
          <h1 className="text-4xl font-bold text-gray-900">Админ-панель</h1>
          <p className="text-gray-600 mt-2">Управление категориями, продуктами и пользователями</p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Link
            href="/admin/categories"
            className="block p-8 bg-white rounded-xl shadow-md hover:shadow-lg transition-shadow border border-gray-200"
          >
            <div className="text-5xl mb-4">🗂️</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Категории</h2>
            <p className="text-gray-600">
              Управление категориями товаров, добавление новых и редактирование существующих
            </p>
          </Link>

          <Link
            href="/admin/products"
            className="block p-8 bg-white rounded-xl shadow-md hover:shadow-lg transition-shadow border border-gray-200"
          >
            <div className="text-5xl mb-4">🛍️</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Продукты</h2>
            <p className="text-gray-600">
              Добавление новых продуктов, редактирование и загрузка кастомных изображений
            </p>
          </Link>

          <Link
            href="/admin/users"
            className="block p-8 bg-white rounded-xl shadow-md hover:shadow-lg transition-shadow border border-gray-200"
          >
            <div className="text-5xl mb-4">👥</div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Пользователи</h2>
            <p className="text-gray-600">
              Управление пользователями, назначение ролей и редактирование профилей
            </p>
          </Link>
        </div>
      </div>
    </div>
  );
}
