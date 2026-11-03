'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { Item } from '@/hooks/useShoppingListItems';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';
import { cn } from '@/lib/utils';
import { X, MessageSquarePlus, Check } from 'lucide-react';

interface ShoppingListItemProps {
  item: Item;
  onToggle: (itemId: string) => void | Promise<void>;
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
  const [isNoteExpanded, setIsNoteExpanded] = useState(false);
  const [noteValue, setNoteValue] = useState(item.note || '');
  const t = useTranslations('lists');
  const locale = useLocale();
  const productName = localizedName(item.product, locale);
  const imageUrl = productImageUrl(item.product, locale);
  const toggleButtonId = `shopping-item-toggle-${item.id}`;

  return (
    <div
      className={cn(
        'relative group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 p-4 rounded-2xl bg-white border-2 border-border/50 shadow-sm transition-all',
        item.isPurchased && 'bg-muted/40 border-transparent opacity-80'
      )}
    >
      {/* Main Content (Left) */}
      <div className="flex items-center gap-2 sm:gap-4 min-w-0">
        <div
          className={cn(
            'flex-shrink-0 transition-transform duration-300',
            item.isPurchased && 'scale-90'
          )}
        >
          {item.product.isCustom && imageUrl ? (
            <Image
              src={imageUrl}
              alt={productName}
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
              {productName}
            </p>
            {item.variant?.name && (
              <span className="text-[10px] bg-secondary/10 text-secondary-foreground px-1.5 py-0.5 rounded-full font-bold">
                {localizedName(item.variant, locale)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right side actions */}
      <div className="flex items-center gap-1 sm:gap-2">
        {onUpdateNote && !isEditingNote && !item.isPurchased && (
          <button
            type="button"
            aria-label={t('item.editNote', { name: productName })}
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
          type="button"
          aria-label={t('item.remove', { name: productName })}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.id);
          }}
          className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full transition-colors opacity-0 group-hover:opacity-100 sm:opacity-100"
        >
          <X size={20} />
        </button>

        <button
          type="button"
          id={toggleButtonId}
          aria-label={t('item.purchased', { name: productName })}
          aria-pressed={item.isPurchased}
          onClick={async (event) => {
            const hadFocus = document.activeElement === event.currentTarget;
            await onToggle(item.id);
            // Moving between sections remounts the item. Restore lost focus, but do
            // not steal it if the user has already moved to another control.
            if (hadFocus && document.activeElement === document.body) {
              document.getElementById(toggleButtonId)?.focus();
            }
          }}
          className="flex items-center justify-center min-w-11 min-h-11 rounded-full cursor-pointer touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex items-center justify-center w-8 h-8 rounded-full border-2 transition-all duration-300',
              item.isPurchased
                ? 'bg-accent border-accent text-white scale-110'
                : 'border-muted-foreground/30 text-transparent hover:border-accent/50'
            )}
          >
            <Check size={16} strokeWidth={item.isPurchased ? 3 : 2} />
          </span>
        </button>
      </div>

      {item.note && !isEditingNote && (
        <button
          type="button"
          aria-expanded={isNoteExpanded}
          onClick={() => setIsNoteExpanded((expanded) => !expanded)}
          className="col-span-2 min-w-0 mt-2 text-left text-sm text-muted-foreground italic rounded cursor-pointer touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          <span className="sr-only">
            {t(isNoteExpanded ? 'item.collapseNote' : 'item.expandNote')}{' '}
          </span>
          <span
            className={cn(
              'block whitespace-break-spaces [overflow-wrap:anywhere]',
              !isNoteExpanded && 'line-clamp-1'
            )}
          >
            {item.note}
          </span>
        </button>
      )}

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
            placeholder={t('item.notePlaceholder')}
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
            {t('item.noteSave')}
          </button>
        </div>
      )}
    </div>
  );
}
