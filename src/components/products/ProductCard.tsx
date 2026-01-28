'use client';

import type { Product } from '@/hooks/useProductSelection';

interface ProductCardProps {
  product: Product;
  isSelected: boolean;
  isFavorite: boolean;
  showFavorite: boolean;
  selectedVariantId?: string | null;
  onToggle: (product: Product) => void;
  onVariantChange?: (productId: string, variantId: string | null) => void;
  onToggleFavorite: (productId: string) => void;
}

export default function ProductCard({
  product,
  isSelected,
  isFavorite,
  showFavorite,
  selectedVariantId,
  onToggle,
  onVariantChange,
  onToggleFavorite,
}: ProductCardProps) {
  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleFavorite(product.id);
  };

  return (
    <div className="relative">
      <button
        onClick={() => onToggle(product)}
        className={`
          w-full bg-white rounded-2xl p-4 shadow-md transition-all
          ${isSelected ? 'ring-4 ring-green-500 scale-95' : 'hover:shadow-lg hover:scale-105'}
        `}
      >
        <div className="text-center">
          <div className="mx-auto mb-2 h-16 w-16 flex items-center justify-center">
            {product.isCustom && product.imageUrl ? (
              <img src={product.imageUrl} alt={product.name} className="h-14 w-14 object-contain" />
            ) : (
              <span className="text-4xl leading-none">{product.emoji}</span>
            )}
          </div>
          <p className="text-sm font-medium text-gray-900">{product.name}</p>
        </div>
      </button>

      {product.variants && product.variants.length > 0 && isSelected && (
        <div className="mt-2">
          <select
            value={selectedVariantId || ''}
            onChange={(event) => onVariantChange?.(product.id, event.target.value || null)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
          >
            <option value="">Без варианта</option>
            {product.variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.emoji ? `${variant.emoji} ` : ''}
                {variant.name}
              </option>
            ))}
          </select>
        </div>
      )}

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
