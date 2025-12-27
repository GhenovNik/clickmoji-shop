'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useShoppingList } from '@/store/shopping-list';

type FavoriteProduct = {
  id: string;
  productId: string;
  usageCount: number;
  product: {
    id: string;
    name: string;
    emoji: string;
    category: {
      id: string;
      name: string;
      emoji: string;
    };
  };
};

const fetchFavoritesAPI = async (): Promise<FavoriteProduct[]> => {
  const res = await fetch('/api/favorites');
  if (!res.ok) throw new Error('Failed to fetch favorites');
  return res.json();
};

const updateFavoriteUsageAPI = async (productId: string) => {
  const res = await fetch('/api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId }),
  });
  if (!res.ok) throw new Error('Failed to update favorite usage');
  return res.json();
};

const removeFavoriteAPI = async (productId: string) => {
  const res = await fetch(`/api/favorites?productId=${productId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to remove favorite');
  return res.json();
};

export default function FavoritesSection() {
  const { data: session } = useSession();
  const addItems = useShoppingList((state) => state.addItems);
  const queryClient = useQueryClient();

  const { data: favorites = [], isLoading: loading } = useQuery({
    queryKey: ['favorites'],
    queryFn: fetchFavoritesAPI,
    enabled: !!session?.user,
  });

  const updateUsageMutation = useMutation({
    mutationFn: updateFavoriteUsageAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: removeFavoriteAPI,
    onMutate: async (productId) => {
      await queryClient.cancelQueries({ queryKey: ['favorites'] });
      const previousFavorites = queryClient.getQueryData<FavoriteProduct[]>(['favorites']);

      queryClient.setQueryData<FavoriteProduct[]>(['favorites'], (old) => {
        if (!old) return old;
        return old.filter((fav) => fav.product.id !== productId);
      });

      return { previousFavorites };
    },
    onError: (err, productId, context) => {
      if (context?.previousFavorites) {
        queryClient.setQueryData(['favorites'], context.previousFavorites);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });

  const handleAddToList = async (favorite: FavoriteProduct) => {
    addItems([
      {
        productId: favorite.product.id,
        name: favorite.product.name,
        emoji: favorite.product.emoji,
        categoryName: favorite.product.category.name,
      },
    ]);

    try {
      await updateUsageMutation.mutateAsync(favorite.product.id);
    } catch (error) {
      console.error('Error updating favorite usage count:', error);
    }
  };

  const handleRemoveFromFavorites = async (productId: string) => {
    try {
      await removeMutation.mutateAsync(productId);
    } catch (error) {
      console.error('Error removing from favorites:', error);
    }
  };

  if (!session?.user) {
    return null;
  }

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="text-gray-500">Загрузка избранного...</div>
      </div>
    );
  }

  if (favorites.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="text-4xl mb-2">⭐</div>
        <p className="text-gray-600">Избранные товары появятся здесь</p>
        <p className="text-sm text-gray-500 mt-1">
          Добавляйте часто используемые товары в избранное
        </p>
      </div>
    );
  }

  return (
    <div className="mb-12">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-900">⭐ Избранное</h2>
        <span className="text-sm text-gray-500">
          {favorites.length} {favorites.length === 1 ? 'товар' : 'товаров'}
        </span>
      </div>

      <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-3">
        {favorites.map((favorite) => (
          <div key={favorite.id} className="relative group">
            <button
              onClick={() => handleAddToList(favorite)}
              className="w-full bg-white rounded-xl p-3 shadow-md hover:shadow-lg hover:scale-105 transition-all"
              title={favorite.product.name}
            >
              <div className="text-3xl sm:text-4xl">{favorite.product.emoji}</div>
            </button>

            {/* Remove button - показывается при наведении */}
            <button
              onClick={() => handleRemoveFromFavorites(favorite.product.id)}
              className="absolute -top-2 -right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              title="Убрать из избранного"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-500 text-center mt-4">
        Нажмите на товар чтобы добавить в список покупок
      </p>
    </div>
  );
}
