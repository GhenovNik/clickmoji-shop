'use client';

import { useRef, useState, type FocusEventHandler, type Ref } from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { Item } from '@/hooks/useShoppingListItems';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';
import { cn } from '@/lib/utils';
import { X, MessageSquarePlus, Check } from 'lucide-react';

interface ShoppingListItemProps {
  item: Item;
  // A row with a request in flight (its writes, retries and the server read after them).
  busy?: boolean;
  onToggle: (itemId: string) => void | Promise<void>;
  onRemove: (itemId: string) => void | Promise<void>;
  onUpdateNote?: (itemId: string, note: string) => void | Promise<void>;
  toggleButtonRef?: Ref<HTMLButtonElement>;
  onToggleFocus?: FocusEventHandler<HTMLButtonElement>;
}

export default function ShoppingListItem({
  item,
  busy = false,
  onToggle,
  onRemove,
  onUpdateNote,
  toggleButtonRef,
  onToggleFocus,
}: ShoppingListItemProps) {
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [isNoteExpanded, setIsNoteExpanded] = useState(false);
  const [noteValue, setNoteValue] = useState(item.note || '');
  // Blur, Enter and the save button may all fire for one edit; only the first starts a save.
  const noteSaveRef = useRef(false);
  const t = useTranslations('lists');
  const locale = useLocale();
  const productName = localizedName(item.product, locale);
  const imageUrl = productImageUrl(item.product, locale);

  // The editor stays open and disabled until the save settles (including a failed save's
  // server read), then closes.
  const saveNote = async () => {
    if (noteSaveRef.current) return;
    noteSaveRef.current = true;
    setIsSavingNote(true);
    try {
      await onUpdateNote?.(item.id, noteValue);
    } finally {
      noteSaveRef.current = false;
      setIsSavingNote(false);
      setIsEditingNote(false);
    }
  };

  const editorDisabled = busy || isSavingNote;

  return (
    <div
      aria-busy={busy || undefined}
      className={cn(
        'relative group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 p-4 rounded-2xl bg-white border-2 border-border/50 shadow-sm transition-all',
        item.isPurchased && 'bg-muted/40 border-transparent opacity-80',
        busy && 'ring-2 ring-primary/40'
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
            disabled={busy}
            aria-label={t('item.editNote', { name: productName })}
            onClick={(e) => {
              e.stopPropagation();
              setIsEditingNote(true);
            }}
            className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/5 rounded-full transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <MessageSquarePlus size={20} />
          </button>
        )}

        <button
          type="button"
          disabled={busy}
          aria-label={t('item.remove', { name: productName })}
          onClick={(e) => {
            e.stopPropagation();
            void onRemove(item.id);
          }}
          className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full transition-colors opacity-0 group-hover:opacity-100 sm:opacity-100 disabled:opacity-50 disabled:pointer-events-none"
        >
          <X size={20} />
        </button>

        <button
          type="button"
          ref={toggleButtonRef}
          disabled={busy}
          onFocus={onToggleFocus}
          aria-label={t('item.purchased', { name: productName })}
          aria-pressed={item.isPurchased}
          onClick={() => onToggle(item.id)}
          className="flex items-center justify-center min-w-11 min-h-11 rounded-full cursor-pointer touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
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
            disabled={editorDisabled}
            onChange={(e) => setNoteValue(e.target.value)}
            onBlur={() => {
              void saveNote();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void saveNote();
              }
              if (e.key === 'Escape') {
                setNoteValue(item.note || '');
                setIsEditingNote(false);
              }
            }}
            placeholder={t('item.notePlaceholder')}
            className="flex-1 px-4 py-2 text-sm bg-muted border-none rounded-xl focus:ring-2 focus:ring-primary outline-none disabled:opacity-60"
            autoFocus
          />
          <button
            type="button"
            disabled={editorDisabled}
            className="px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-xl disabled:opacity-60"
            onClick={() => {
              void saveNote();
            }}
          >
            {t('item.noteSave')}
          </button>
        </div>
      )}
    </div>
  );
}
