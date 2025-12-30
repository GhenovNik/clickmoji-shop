'use client';

import type { Item } from '@/hooks/useShoppingListItems';

interface ShoppingListItemProps {
  item: Item;
  onToggle: (itemId: string) => void;
  onRemove: (itemId: string) => void;
}

export default function ShoppingListItem({ item, onToggle, onRemove }: ShoppingListItemProps) {
  return (
    <div
      className={`bg-white rounded-xl p-4 shadow-md flex items-center gap-4 ${
        item.isPurchased ? 'opacity-60' : ''
      }`}
    >
      <button
        onClick={() => onToggle(item.id)}
        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${
          item.isPurchased
            ? 'bg-green-500 hover:bg-green-600'
            : 'border-2 border-gray-300 hover:border-green-500'
        }`}
      >
        {item.isPurchased && <span className="text-white text-xl">✓</span>}
      </button>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          {item.product.isCustom && item.product.imageUrl ? (
            <img
              src={item.product.imageUrl}
              alt={item.product.name}
              className="w-12 h-12 object-contain"
            />
          ) : (
            <span className="text-3xl">{item.product.emoji}</span>
          )}
          <div>
            <p className={`font-medium text-gray-900 ${item.isPurchased ? 'line-through' : ''}`}>
              {item.product.name}
            </p>
            <p className="text-sm text-gray-500">{item.product.category.name}</p>
          </div>
        </div>
      </div>
      <button
        onClick={() => onRemove(item.id)}
        className="text-red-500 hover:text-red-700 px-3 py-1 rounded transition-colors"
      >
        ✕
      </button>
    </div>
  );
}
