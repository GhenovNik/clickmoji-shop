'use client';

import { useState } from 'react';
import Image from 'next/image';
import type { Item } from '@/hooks/useShoppingListItems';
import { cn } from '@/lib/utils';
import { MoreHorizontal, X, MessageSquarePlus, Check } from 'lucide-react';

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
      className={cn(
        'relative group flex items-center justify-between p-4 rounded-2xl bg-white border-2 border-border/50 shadow-sm transition-all cursor-pointer touch-manipulation',
        item.isPurchased && 'bg-muted/40 border-transparent opacity-80'
      )}
      onClick={() => onToggle(item.id)}
    >
      {/* Main Content (Left) */}
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <div
          className={cn(
            'flex-shrink-0 transition-transform duration-300',
            item.isPurchased && 'scale-90'
          )}
        >
          {item.product.isCustom && item.product.imageUrl ? (
            <Image
              src={item.product.imageUrl}
              alt={item.product.name}
              width={48}
              height={48}
              className="w-12 h-12 object-contain"
            />
          ) : (
            <span className="text-4xl drop-shadow-sm">{item.product.emoji}</span>
          )}
        </div>

        <div className="flex flex-col flex-1 min-w-0 justify-center">
          <div className="flex items-center gap-2 flex-wrap">
            <p
              className={cn(
                'font-bold text-lg leading-tight truncate transition-all duration-300',
                item.isPurchased ? 'line-through text-muted-foreground' : 'text-foreground'
              )}
            >
              {item.product.name}
            </p>
            {item.variant?.name && (
              <span className="text-[10px] bg-secondary/10 text-secondary-foreground px-1.5 py-0.5 rounded-full font-bold">
                {item.variant.name}
              </span>
            )}
          </div>

          {item.note && !isEditingNote && (
            <span className="text-sm text-muted-foreground line-clamp-1 italic mt-0.5">
              {item.note}
            </span>
          )}
        </div>
      </div>

      {/* Right side actions */}
      <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0 ml-2">
        {onUpdateNote && !isEditingNote && !item.isPurchased && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsEditingNote(true);
            }}
            className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/5 rounded-full transition-colors"
          >
            <MessageSquarePlus size={20} />
          </button>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.id);
          }}
          className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full transition-colors opacity-0 group-hover:opacity-100 sm:opacity-100"
        >
          <X size={20} />
        </button>

        {/* Checkbox indicator */}
        <div
          className={cn(
            'flex items-center justify-center w-8 h-8 rounded-full border-2 transition-all duration-300 ml-1',
            item.isPurchased
              ? 'bg-accent border-accent text-white scale-110'
              : 'border-muted-foreground/30 text-transparent hover:border-accent/50'
          )}
        >
          <Check size={16} strokeWidth={item.isPurchased ? 3 : 2} />
        </div>
      </div>

      {/* Note Editor Overlay */}
      {isEditingNote && (
        <div
          className="absolute inset-0 bg-white/95 z-10 rounded-2xl p-2 flex items-center gap-2 shadow-md"
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
            placeholder="Заметка к товару..."
            className="flex-1 px-4 py-2 text-sm bg-muted border-none rounded-xl focus:ring-2 focus:ring-primary outline-none"
            autoFocus
          />
          <button
            className="px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-xl"
            onClick={() => {
              onUpdateNote?.(item.id, noteValue);
              setIsEditingNote(false);
            }}
          >
            Ок
          </button>
        </div>
      )}
    </div>
  );
}
