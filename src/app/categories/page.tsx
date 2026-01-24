'use client';

import { Suspense, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useLists } from '@/store/lists';
import ProductSearch from '@/components/ProductSearch';
import { CategoryCardSkeleton } from '@/components/ui/Skeleton';

type Category = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  order: number;
  _count?: {
    products: number;
  };
};

const fetchCategoriesAPI = async (): Promise<Category[]> => {
  const res = await fetch('/api/categories');
  if (!res.ok) throw new Error('Failed to fetch categories');
  return res.json();
};

function CategoriesPageContent() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const { setActiveList } = useLists();

  // Set active list from URL parameter
  useEffect(() => {
    const listIdFromUrl = searchParams.get('listId');
    if (listIdFromUrl) {
      setActiveList(listIdFromUrl);
    }
  }, [searchParams, setActiveList]);

  const { data: categories = [], isLoading: loading } = useQuery({
    queryKey: ['categories'],
    queryFn: fetchCategoriesAPI,
  });

  // Prepare categories list with Favorites as first item (if user is logged in)
  const displayCategories = session?.user
    ? [
        {
          id: 'favorites',
          name: 'Избранное',
          nameEn: 'Favorites',
          emoji: '⭐',
          isCustom: false,
          imageUrl: null,
          order: -1,
        } as Category,
        ...categories,
      ]
    : categories;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 text-gray-900">📁 Выберите категорию</h1>
          <p className="text-gray-700 mb-6">Выберите категорию товаров для вашего списка</p>

          {/* Search */}
          <ProductSearch />
        </div>

        {/* Categories Grid */}
        <div
          data-testid="categories-grid"
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
        >
          {loading
            ? Array.from({ length: 8 }).map((_, i) => <CategoryCardSkeleton key={i} />)
            : displayCategories.map((category) => {
                const listIdParam = searchParams.get('listId');
                const listQuery = listIdParam ? `?listId=${listIdParam}` : '';
                return (
                  <Link
                    key={category.id}
                    href={
                      category.id === 'favorites'
                        ? `/categories/favorites${listQuery}`
                        : `/categories/${category.id}/products${listQuery}`
                    }
                    data-testid="category-link"
                    className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all hover:scale-105 cursor-pointer"
                  >
                    <div className="text-center">
                      {category.isCustom && category.imageUrl ? (
                        <img
                          src={category.imageUrl}
                          alt={category.name}
                          className="w-24 h-24 object-contain mx-auto mb-3"
                        />
                      ) : (
                        <div className="text-6xl mb-3">{category.emoji}</div>
                      )}
                      <h3 className="font-semibold text-lg mb-1 text-gray-900">{category.name}</h3>
                      {category._count && (
                        <p className="text-sm text-gray-600">{category._count.products} товаров</p>
                      )}
                    </div>
                  </Link>
                );
              })}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-center gap-6 mt-8">
          <Link href="/history" className="text-blue-600 hover:text-blue-800 underline">
            История покупок
          </Link>
          <span className="text-gray-400">|</span>
          <Link href="/" className="text-blue-600 hover:text-blue-800 underline">
            На главную
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function CategoriesPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 flex items-center justify-center">
          <div className="text-2xl">Загрузка...</div>
        </div>
      }
    >
      <CategoriesPageContent />
    </Suspense>
  );
}
