'use client';

import type { FavoriteProduct } from '@/hooks/useFavorites';

interface FavoriteCardProps {
  favorite: FavoriteProduct;
  isSelected: boolean;
  onToggle: (productId: string) => void;
  onRemove: (productId: string) => void;
}

export default function FavoriteCard({
  favorite,
  isSelected,
  onToggle,
  onRemove,
}: FavoriteCardProps) {
  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(favorite.product.id);
  };

  return (
    <div className="relative">
      <button
        onClick={() => onToggle(favorite.product.id)}
        className={`
          w-full bg-white rounded-2xl p-4 shadow-md transition-all
          ${isSelected ? 'ring-4 ring-green-500 scale-95' : 'hover:shadow-lg hover:scale-105'}
        `}
      >
        <div className="text-center">
          <div className="text-4xl mb-2">{favorite.product.emoji}</div>
          <p className="text-sm font-medium text-gray-900">{favorite.product.name}</p>
        </div>
      </button>

      <button
        onClick={handleRemoveClick}
        className="absolute -top-2 -right-2 w-8 h-8 rounded-full shadow-lg bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-all"
        title="Убрать из избранного"
      >
        <span className="text-lg">✕</span>
      </button>
    </div>
  );
}
