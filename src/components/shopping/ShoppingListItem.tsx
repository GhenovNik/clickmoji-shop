'use client';

import { useState } from 'react';
import type { Item } from '@/hooks/useShoppingListItems';

interface ShoppingListItemProps {
  item: Item;
  onToggle: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onUpdateNote?: (itemId: string, note: string) => void;
}

export default function ShoppingListItem({
  item,
  onToggle,
  onRemove,
  onUpdateNote,
}: ShoppingListItemProps) {
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteValue, setNoteValue] = useState(item.note || '');
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
          <div className="flex-1">
            <p className={`font-medium text-gray-900 ${item.isPurchased ? 'line-through' : ''}`}>
              {item.product.name}
            </p>
            <p className="text-sm text-gray-500">{item.product.category.name}</p>
            {!isEditingNote && item.note && (
              <p className="text-sm text-gray-600 mt-1 italic">{item.note}</p>
            )}
            {isEditingNote && onUpdateNote && (
              <div className="mt-2">
                <input
                  type="text"
                  value={noteValue}
                  onChange={(e) => setNoteValue(e.target.value)}
                  onBlur={() => {
                    onUpdateNote(item.id, noteValue);
                    setIsEditingNote(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      onUpdateNote(item.id, noteValue);
                      setIsEditingNote(false);
                    }
                    if (e.key === 'Escape') {
                      setNoteValue(item.note || '');
                      setIsEditingNote(false);
                    }
                  }}
                  placeholder="Добавить заметку (например, 2 кг, красные)"
                  className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:border-blue-500"
                  autoFocus
                />
              </div>
            )}
            {!isEditingNote && onUpdateNote && (
              <button
                onClick={() => setIsEditingNote(true)}
                className="text-xs text-blue-600 hover:text-blue-800 mt-1"
                title="Используйте заметки для количества и деталей"
              >
                {item.note ? 'Изменить заметку' : '+ Заметка (количество, детали)'}
              </button>
            )}
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
