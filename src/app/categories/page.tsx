'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import ProductSearch from '@/components/ProductSearch';

type Category = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  order: number;
  _count?: {
    products: number;
  };
};

export default function CategoriesPage() {
  const { data: session } = useSession();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/categories')
      .then((res) => res.json())
      .then((data) => {
        setCategories(data);
        setLoading(false);
      })
      .catch((error) => {
        console.error('Error loading categories:', error);
        setLoading(false);
      });
  }, []);

  // Prepare categories list with Favorites as first item (if user is logged in)
  const displayCategories = session?.user
    ? [
        {
          id: 'favorites',
          name: 'Избранное',
          nameEn: 'Favorites',
          emoji: '⭐',
          order: -1,
        } as Category,
        ...categories,
      ]
    : categories;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 text-gray-900">🛒 Выберите категорию</h1>
          <p className="text-gray-700 mb-6">Выберите категорию товаров для списка покупок</p>

          {/* Search */}
          <ProductSearch />
        </div>

        {/* Categories Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {displayCategories.map((category) => (
            <Link
              key={category.id}
              href={
                category.id === 'favorites'
                  ? '/categories/favorites'
                  : `/categories/${category.id}/products`
              }
              className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all hover:scale-105 cursor-pointer"
            >
              <div className="text-center">
                <div className="text-6xl mb-3">{category.emoji}</div>
                <h3 className="font-semibold text-lg mb-1 text-gray-900">{category.name}</h3>
                {category._count && (
                  <p className="text-sm text-gray-600">{category._count.products} товаров</p>
                )}
              </div>
            </Link>
          ))}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-center gap-6 mt-8">
          <Link href="/history" className="text-blue-600 hover:text-blue-800 underline">
            История покупок
          </Link>
          <span className="text-gray-400">•</span>
          <Link href="/" className="text-blue-600 hover:text-blue-800 underline">
            На главную
          </Link>
        </div>
      </div>
    </div>
  );
}
