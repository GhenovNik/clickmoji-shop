'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useLists } from '@/store/lists';

type Product = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  category: {
    id: string;
    name: string;
    emoji: string;
  };
};

export default function ProductsPage() {
  const params = useParams();
  const router = useRouter();
  const categoryId = params.categoryId as string;
  const { data: session } = useSession();
  const { lists, activeListId, setLists } = useLists();

  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [favoriteProducts, setFavoriteProducts] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  // Load lists
  useEffect(() => {
    if (session?.user && lists.length === 0) {
      fetch('/api/lists')
        .then((res) => res.json())
        .then((data) => setLists(data))
        .catch((error) => console.error('Error loading lists:', error));
    }
  }, [session, lists.length, setLists]);

  useEffect(() => {
    fetch(`/api/products?categoryId=${categoryId}`)
      .then((res) => res.json())
      .then((data) => {
        setProducts(data);
        setLoading(false);
      })
      .catch((error) => {
        console.error('Error loading products:', error);
        setLoading(false);
      });
  }, [categoryId]);

  // Загружаем избранное если пользователь авторизован
  useEffect(() => {
    if (session?.user) {
      fetch('/api/favorites')
        .then((res) => res.json())
        .then((favorites) => {
          const favoriteIds = new Set<string>(favorites.map((fav: { product: { id: string } }) => fav.product.id));
          setFavoriteProducts(favoriteIds);
        })
        .catch((error) => {
          console.error('Error loading favorites:', error);
        });
    }
  }, [session]);

  const toggleProduct = (productId: string) => {
    setSelectedProducts((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(productId)) {
        newSet.delete(productId);
      } else {
        newSet.add(productId);
      }
      return newSet;
    });
  };

  const toggleFavorite = async (productId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent product selection

    if (!session?.user) {
      alert('Войдите чтобы добавить товары в избранное');
      return;
    }

    const isFavorite = favoriteProducts.has(productId);

    try {
      if (isFavorite) {
        // Удаляем из избранного
        await fetch(`/api/favorites?productId=${productId}`, {
          method: 'DELETE',
        });
        setFavoriteProducts((prev) => {
          const newSet = new Set(prev);
          newSet.delete(productId);
          return newSet;
        });
      } else {
        // Добавляем в избранное
        await fetch('/api/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId }),
        });
        setFavoriteProducts((prev) => new Set([...prev, productId]));
      }
    } catch (error) {
      console.error('Error toggling favorite:', error);
    }
  };

  const handleAddToList = async () => {
    if (!activeListId) {
      alert('Сначала выберите список');
      return;
    }

    setAdding(true);

    const selectedItems = products
      .filter((product) => selectedProducts.has(product.id))
      .map((product) => ({
        productId: product.id,
      }));

    try {
      await fetch(`/api/lists/${activeListId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: selectedItems }),
      });

      // Refresh lists to update counts
      const listsResponse = await fetch('/api/lists');
      if (listsResponse.ok) {
        const listsData = await listsResponse.json();
        setLists(listsData);
      }

      // Navigate to active list or lists page
      if (activeListId) {
        router.push(`/lists/${activeListId}`);
      } else {
        router.push('/lists');
      }
    } catch (error) {
      console.error('Error adding items to list:', error);
      alert('Ошибка при добавлении товаров');
    } finally {
      setAdding(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  const category = products[0]?.category;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 pb-32">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-2">{category?.emoji}</div>
          <h1 className="text-4xl font-bold mb-2 text-gray-900">{category?.name}</h1>
          <p className="text-gray-700">Выберите товары одним нажатием</p>
        </div>

        {/* Products Grid */}
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {products.map((product) => {
            const isSelected = selectedProducts.has(product.id);
            const isFavorite = favoriteProducts.has(product.id);
            return (
              <div key={product.id} className="relative">
                <button
                  onClick={() => toggleProduct(product.id)}
                  className={`
                    w-full bg-white rounded-2xl p-4 shadow-md transition-all
                    ${isSelected
                      ? 'ring-4 ring-green-500 scale-95'
                      : 'hover:shadow-lg hover:scale-105'
                    }
                  `}
                >
                  <div className="text-center">
                    <div className="text-4xl mb-2">{product.emoji}</div>
                    <p className="text-sm font-medium text-gray-900">{product.name}</p>
                  </div>
                </button>

                {/* Favorite button */}
                {session?.user && (
                  <button
                    onClick={(e) => toggleFavorite(product.id, e)}
                    className={`
                      absolute -top-2 -right-2 w-8 h-8 rounded-full shadow-lg
                      flex items-center justify-center transition-all
                      ${isFavorite
                        ? 'bg-yellow-400 hover:bg-yellow-500 scale-110'
                        : 'bg-white hover:bg-yellow-100'
                      }
                    `}
                    title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                  >
                    <span className="text-xl">
                      {isFavorite ? '⭐' : '☆'}
                    </span>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Back Link */}
        <div className="text-center mt-8">
          <Link
            href="/categories"
            className="text-blue-600 hover:text-blue-800 underline"
          >
            ← Назад к категориям
          </Link>
        </div>
      </div>

      {/* Fixed Bottom Button */}
      {selectedProducts.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="text-lg font-semibold">
              Выбрано: {selectedProducts.size}
            </div>
            <button
              onClick={handleAddToList}
              disabled={adding}
              className="bg-green-500 hover:bg-green-600 text-white px-8 py-3 rounded-xl font-semibold transition-colors disabled:opacity-50"
            >
              {adding ? 'Добавление...' : 'Добавить в список'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
