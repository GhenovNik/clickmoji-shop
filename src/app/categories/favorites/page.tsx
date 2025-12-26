'use client';

import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useFavorites } from '@/hooks/useFavorites';
import FavoriteCard from '@/components/favorites/FavoriteCard';
import ProductSelectionBar from '@/components/products/ProductSelectionBar';

export default function FavoritesPage() {
  const { data: session } = useSession();
  const {
    favorites,
    selectedProducts,
    loading,
    adding,
    toggleProduct,
    removeFromFavorites,
    addToList,
  } = useFavorites();

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
        <div className="text-center mb-8">
          <div className="text-6xl mb-2">⭐</div>
          <h1 className="text-4xl font-bold mb-2 text-gray-900">Избранное</h1>
          <p className="text-gray-700">Ваши любимые товары</p>
        </div>

        {favorites.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-2xl shadow-md">
            <div className="text-4xl mb-4">☆</div>
            <p className="text-gray-600 mb-2">У вас пока нет избранных товаров</p>
            <p className="text-sm text-gray-500">
              Добавляйте товары в избранное нажатием на звездочку
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {favorites.map((favorite) => (
              <FavoriteCard
                key={favorite.id}
                favorite={favorite}
                isSelected={selectedProducts.has(favorite.product.id)}
                onToggle={toggleProduct}
                onRemove={removeFromFavorites}
              />
            ))}
          </div>
        )}

        <div className="text-center mt-8">
          <Link href="/categories" className="text-blue-600 hover:text-blue-800 underline">
            ← Назад к категориям
          </Link>
        </div>
      </div>

      <ProductSelectionBar count={selectedProducts.size} adding={adding} onAddToList={addToList} />
    </div>
  );
}
