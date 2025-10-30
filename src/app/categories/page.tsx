'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Category = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  order: number;
  _count: {
    products: number;
  };
};

export default function CategoriesPage() {
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
          <h1 className="text-4xl font-bold mb-2">🛒 Выберите категорию</h1>
          <p className="text-gray-600">Выберите категорию товаров для списка покупок</p>
        </div>

        {/* Categories Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {categories.map((category) => (
            <Link
              key={category.id}
              href={`/categories/${category.id}/products`}
              className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all hover:scale-105 cursor-pointer"
            >
              <div className="text-center">
                <div className="text-6xl mb-3">{category.emoji}</div>
                <h3 className="font-semibold text-lg mb-1">{category.name}</h3>
                <p className="text-sm text-gray-500">
                  {category._count.products} товаров
                </p>
              </div>
            </Link>
          ))}
        </div>

        {/* Back to Home */}
        <div className="text-center mt-8">
          <Link
            href="/"
            className="text-blue-600 hover:text-blue-800 underline"
          >
            ← На главную
          </Link>
        </div>
      </div>
    </div>
  );
}
