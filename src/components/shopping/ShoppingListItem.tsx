'use client';

import { useState } from 'react';
import type { Item } from '@/hooks/useShoppingListItems';
import { cn } from '@/lib/utils';
import { MoreHorizontal, X, MessageSquarePlus } from 'lucide-react';

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
  const [showActions, setShowActions] = useState(false);

  return (
    <div
      className={cn(
        'relative group bento-card p-3 flex flex-col items-center justify-center gap-1 min-h-[120px] cursor-pointer touch-manipulation transition-all',
        item.isPurchased && 'bg-muted border-transparent opacity-50 grayscale'
      )}
      onClick={() => onToggle(item.id)}
    >
      {/* Top right actions */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.id);
          }}
          className="p-1.5 bg-destructive/10 text-destructive rounded-full hover:bg-destructive hover:text-white transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Main Content */}
      <div className="flex flex-col items-center text-center">
        {item.product.isCustom && item.product.imageUrl ? (
          <img
            src={item.product.imageUrl}
            alt={item.product.name}
            className="w-16 h-16 object-contain mb-1"
          />
        ) : (
          <span className="text-5xl mb-1 drop-shadow-sm">{item.product.emoji}</span>
        )}

        <p
          className={cn(
            'font-bold text-sm leading-tight max-w-[100px] line-clamp-2',
            item.isPurchased && 'line-through text-muted-foreground'
          )}
        >
          {item.product.name}
        </p>

        {item.variant?.name && (
          <span className="text-[10px] bg-secondary/10 text-secondary-foreground px-1.5 py-0.5 rounded-full font-bold mt-1">
            {item.variant.name}
          </span>
        )}

        {item.note && !isEditingNote && (
          <span className="text-[10px] text-muted-foreground mt-1 px-2 line-clamp-1 italic">
            "{item.note}"
          </span>
        )}
      </div>

      {/* Note Edit Trigger */}
      {onUpdateNote && !isEditingNote && !item.isPurchased && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsEditingNote(true);
          }}
          className="mt-2 p-1 text-primary hover:bg-primary/5 rounded-full"
        >
          <MessageSquarePlus size={16} />
        </button>
      )}

      {/* Note Editor Overlay */}
      {isEditingNote && (
        <div
          className="absolute inset-0 bg-white/95 z-10 rounded-3xl p-3 flex flex-col items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            value={noteValue}
            onChange={(e) => setNoteValue(e.target.value)}
            onBlur={() => {
              onUpdateNote?.(item.id, noteValue);
              setIsEditingNote(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onUpdateNote?.(item.id, noteValue);
                setIsEditingNote(false);
              }
              if (e.key === 'Escape') {
                setNoteValue(item.note || '');
                setIsEditingNote(false);
              }
            }}
            placeholder="Заметка..."
            className="w-full px-3 py-2 text-sm bg-muted border-none rounded-xl focus:ring-2 focus:ring-primary outline-none"
            autoFocus
          />
          <button
            className="mt-2 text-xs font-bold text-primary"
            onClick={() => {
              onUpdateNote?.(item.id, noteValue);
              setIsEditingNote(false);
            }}
          >
            Готово
          </button>
        </div>
      )}

      {/* Purchase Indicator */}
      {item.isPurchased && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent/10 rounded-3xl">
          <div className="bg-accent text-white rounded-full p-2 shadow-lg scale-125">
            <span className="text-xl">✓</span>
          </div>
        </div>
      )}
    </div>
  );
}
