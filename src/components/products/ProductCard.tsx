'use client';

import type { Product } from '@/hooks/useProductSelection';

interface ProductCardProps {
  product: Product;
  isSelected: boolean;
  isFavorite: boolean;
  showFavorite: boolean;
  onToggle: (productId: string) => void;
  onToggleFavorite: (productId: string) => void;
}

export default function ProductCard({
  product,
  isSelected,
  isFavorite,
  showFavorite,
  onToggle,
  onToggleFavorite,
}: ProductCardProps) {
  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleFavorite(product.id);
  };

  return (
    <div className="relative">
      <button
        onClick={() => onToggle(product.id)}
        className={`
          w-full bg-white rounded-2xl p-4 shadow-md transition-all
          ${isSelected ? 'ring-4 ring-green-500 scale-95' : 'hover:shadow-lg hover:scale-105'}
        `}
      >
        <div className="text-center">
          <div className="text-4xl mb-2">{product.emoji}</div>
          <p className="text-sm font-medium text-gray-900">{product.name}</p>
        </div>
      </button>

      {showFavorite && (
        <button
          onClick={handleFavoriteClick}
          className={`
            absolute -top-2 -right-2 w-8 h-8 rounded-full shadow-lg
            flex items-center justify-center transition-all
            ${isFavorite ? 'bg-yellow-400 hover:bg-yellow-500 scale-110' : 'bg-white hover:bg-yellow-100'}
          `}
          title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
        >
          <span className="text-xl">{isFavorite ? '⭐' : '☆'}</span>
        </button>
      )}
    </div>
  );
}
