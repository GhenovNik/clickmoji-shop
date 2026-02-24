'use client';

import Link from 'next/link';

interface ShoppingListEmptyStateProps {
  listName: string;
}

export default function ShoppingListEmptyState({ listName }: ShoppingListEmptyStateProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6 hidden sm:flex items-center justify-between gap-4">
          <Link
            href="/lists"
            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
          >
            <span>←</span>
            <span>К спискам</span>
          </Link>
        </div>

        <div
          className="flex items-center justify-center"
          style={{ minHeight: 'calc(100vh - 200px)' }}
        >
          <div className="text-center">
            <div className="text-8xl mb-4">🛒</div>
            <h1 className="text-3xl font-bold mb-4 text-gray-900">{listName} пуст</h1>
            <p className="text-gray-700 mb-8">Добавьте товары из категорий</p>
            <Link
              href="/categories"
              className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-semibold transition-colors"
            >
              Добавить товары
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
