'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useShoppingList } from '@/store/shopping-list';

type FavoriteProduct = {
  id: string;
  productId: string;
  product: {
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
};

export default function FavoritesPage() {
  const router = useRouter();
  const addItems = useShoppingList((state) => state.addItems);
  const { data: session } = useSession();

  const [favorites, setFavorites] = useState<FavoriteProduct[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session?.user) {
      router.push('/auth/signin');
      return;
    }

    fetch('/api/favorites')
      .then((res) => res.json())
      .then((data) => {
        setFavorites(data);
        setLoading(false);
      })
      .catch((error) => {
        console.error('Error loading favorites:', error);
        setLoading(false);
      });
  }, [session, router]);

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

  const removeFromFavorites = async (productId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    try {
      await fetch(`/api/favorites?productId=${productId}`, {
        method: 'DELETE',
      });
      setFavorites((prev) => prev.filter((fav) => fav.product.id !== productId));
      // Also remove from selected if it was selected
      setSelectedProducts((prev) => {
        const newSet = new Set(prev);
        newSet.delete(productId);
        return newSet;
      });
    } catch (error) {
      console.error('Error removing from favorites:', error);
    }
  };

  const handleAddToList = () => {
    const selectedItems = favorites
      .filter((fav) => selectedProducts.has(fav.product.id))
      .map((fav) => ({
        productId: fav.product.id,
        name: fav.product.name,
        emoji: fav.product.emoji,
        categoryName: fav.product.category.name,
      }));

    addItems(selectedItems);
    router.push('/shopping-list');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  if (!session?.user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 pb-32">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-2">⭐</div>
          <h1 className="text-4xl font-bold mb-2 text-gray-900">Избранное</h1>
          <p className="text-gray-700">Ваши любимые товары</p>
        </div>

        {favorites.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-2xl shadow-md">
            <div className="text-4xl mb-4">☆</div>
            <p className="text-gray-600 mb-2">
              У вас пока нет избранных товаров
            </p>
            <p className="text-sm text-gray-500">
              Добавляйте товары в избранное нажатием на звездочку
            </p>
          </div>
        ) : (
          <>
            {/* Products Grid */}
            <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {favorites.map((favorite) => {
                const isSelected = selectedProducts.has(favorite.product.id);
                return (
                  <div key={favorite.id} className="relative">
                    <button
                      onClick={() => toggleProduct(favorite.product.id)}
                      className={`
                        w-full bg-white rounded-2xl p-4 shadow-md transition-all
                        ${isSelected
                          ? 'ring-4 ring-green-500 scale-95'
                          : 'hover:shadow-lg hover:scale-105'
                        }
                      `}
                    >
                      <div className="text-center">
                        <div className="text-4xl mb-2">{favorite.product.emoji}</div>
                        <p className="text-sm font-medium text-gray-900">{favorite.product.name}</p>
                      </div>
                    </button>

                    {/* Remove from favorites button */}
                    <button
                      onClick={(e) => removeFromFavorites(favorite.product.id, e)}
                      className="absolute -top-2 -right-2 w-8 h-8 rounded-full shadow-lg bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-all"
                      title="Убрать из избранного"
                    >
                      <span className="text-lg">✕</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

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
              className="bg-green-500 hover:bg-green-600 text-white px-8 py-3 rounded-xl font-semibold transition-colors"
            >
              Добавить в список
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
