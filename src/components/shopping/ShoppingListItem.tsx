'use client';

import { useState, type FocusEventHandler, type Ref } from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { Item } from '@/hooks/useShoppingListItems';
import type { ShoppingView } from '@/hooks/useShoppingListPresentation';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';
import { cn } from '@/lib/utils';
import { X, MessageSquarePlus, Check } from 'lucide-react';

interface ShoppingListItemProps {
  item: Item;
  onToggle: (itemId: string) => void | Promise<void>;
  onRemove: (itemId: string) => void;
  onUpdateNote?: (itemId: string, note: string) => void;
  toggleButtonRef?: Ref<HTMLButtonElement>;
  onToggleFocus?: FocusEventHandler<HTMLButtonElement>;
  view?: ShoppingView;
}

export default function ShoppingListItem({
  item,
  onToggle,
  onRemove,
  onUpdateNote,
  toggleButtonRef,
  onToggleFocus,
  view = 'list',
}: ShoppingListItemProps) {
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [isNoteExpanded, setIsNoteExpanded] = useState(false);
  const [noteValue, setNoteValue] = useState(item.note || '');
  const t = useTranslations('lists');
  const locale = useLocale();
  const productName = localizedName(item.product, locale);
  const imageUrl = productImageUrl(item.product, locale);

  return (
    <div
      data-testid="shopping-item"
      data-item-id={item.id}
      className={cn(
        'relative group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1 min-h-14 px-2 py-1 rounded-xl bg-white border border-border/50 shadow-sm transition-colors',
        item.isPurchased && 'bg-green-50/80 border-green-100',
        view === 'grid' && 'px-1',
        view === 'grid' && isNoteExpanded && 'col-span-full'
      )}
    >
      {/* Main Content (Left) */}
      <div
        className={cn(
          'row-span-2 flex-shrink-0 transition-transform duration-300',
          item.isPurchased && 'scale-90'
        )}
      >
        {item.product.isCustom && imageUrl ? (
          <Image
            src={imageUrl}
            alt={productName}
            width={32}
            height={32}
            className={cn('w-8 h-8 object-contain', view === 'grid' && 'w-6 h-6')}
          />
        ) : (
          <span
            className={cn('text-3xl leading-none drop-shadow-sm', view === 'grid' && 'text-2xl')}
          >
            {item.product.emoji}
          </span>
        )}
      </div>

      <div
        className={cn(
          'min-w-0',
          item.note && !isNoteExpanded && !isEditingNote ? 'self-end' : 'row-span-2'
        )}
      >
        <div className="flex items-center gap-1 min-w-0">
          <p
            className={cn(
              'font-bold text-base leading-5 truncate transition-all duration-300',
              view === 'grid' && 'text-xs leading-4',
              item.isPurchased ? 'line-through text-muted-foreground' : 'text-foreground'
            )}
          >
            {productName}
          </p>
          {item.variant?.name && (
            <span className="max-w-1/2 truncate text-[10px] bg-secondary/10 text-secondary-foreground px-1.5 py-0.5 rounded-full font-bold">
              {localizedName(item.variant, locale)}
            </span>
          )}
        </div>
      </div>

      {/* Right side actions */}
      <div
        className={cn(
          'col-start-3 row-start-1 row-span-2 flex items-center',
          view === 'grid' && 'grid grid-cols-[24px_44px] grid-rows-2'
        )}
      >
        {onUpdateNote && !isEditingNote && !item.isPurchased && (
          <button
            type="button"
            aria-label={t('item.editNote', { name: productName })}
            onClick={(e) => {
              e.stopPropagation();
              setIsEditingNote(true);
            }}
            className="flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-primary hover:bg-primary/5 rounded-full transition-colors"
          >
            <MessageSquarePlus size={16} />
          </button>
        )}

        <button
          type="button"
          aria-label={t('item.remove', { name: productName })}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.id);
          }}
          className={cn(
            'flex items-center justify-center w-6 h-6 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 rounded-full transition-colors',
            view === 'grid' && 'col-start-1 row-start-2'
          )}
        >
          <X size={14} />
        </button>

        <button
          type="button"
          ref={toggleButtonRef}
          onFocus={onToggleFocus}
          aria-label={t('item.purchased', { name: productName })}
          aria-pressed={item.isPurchased}
          onClick={() => onToggle(item.id)}
          className={cn(
            'flex items-center justify-center min-w-11 min-h-11 rounded-full cursor-pointer touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
            view === 'grid' && 'col-start-2 row-start-1 row-span-2'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex items-center justify-center w-7 h-7 rounded-full border-2 transition-all duration-300',
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
          className={cn(
            'min-w-0 text-left text-xs leading-4 text-muted-foreground italic rounded cursor-pointer touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
            isNoteExpanded
              ? 'col-span-3 col-start-1 row-start-3 mt-1'
              : 'col-start-2 row-start-2 self-start'
          )}
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
            aria-label={t('item.editNote', { name: productName })}
            className="min-w-0 flex-1 px-2 py-2 text-sm bg-muted border-none rounded-xl focus:ring-2 focus:ring-primary outline-none"
            autoFocus
          />
          <button
            className="px-2 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-xl"
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
