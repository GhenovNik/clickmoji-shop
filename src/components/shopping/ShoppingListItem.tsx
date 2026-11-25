'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type Ref,
} from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import type { Item } from '@/hooks/useShoppingListItems';
import type { ShoppingView } from '@/hooks/useShoppingListPresentation';
import { localizedName, namesOf } from '@/lib/catalog-name';
import { LocalizedName } from '@/components/ui/LocalizedName';
import { productImageUrl } from '@/lib/product-image';
import { cn } from '@/lib/utils';
import { X, MoreHorizontal, MessageSquarePlus, Check } from 'lucide-react';

interface ShoppingListItemProps {
  item: Item;
  // A row with a request in flight (its writes, retries and the server read after them).
  busy?: boolean;
  onToggle: (itemId: string) => void | Promise<void>;
  onRemove: (itemId: string) => void | Promise<void>;
  onUpdateNote?: (itemId: string, note: string) => void | Promise<void>;
  toggleButtonRef?: Ref<HTMLButtonElement>;
  onToggleFocus?: FocusEventHandler<HTMLButtonElement>;
  view?: ShoppingView;
}

export default function ShoppingListItem({
  item,
  busy = false,
  onToggle,
  onRemove,
  onUpdateNote,
  toggleButtonRef,
  onToggleFocus,
  view = 'list',
}: ShoppingListItemProps) {
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false);
  const cancelRemovalRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRemoveFocus = useRef(false);
  const swipeStart = useRef<{ x: number; y: number; id: number } | null>(null);
  const [isNoteExpanded, setIsNoteExpanded] = useState(false);
  const [noteValue, setNoteValue] = useState(item.note || '');
  // Blur, Enter and the save button may all fire for one edit; only the first starts a save.
  const noteSaveRef = useRef(false);
  const t = useTranslations('lists');
  const locale = useLocale();
  const productName = localizedName(item.product, locale);
  const imageUrl = productImageUrl(item.product, locale);

  useEffect(() => {
    if (isConfirmingRemoval) cancelRemovalRef.current?.focus();
  }, [isConfirmingRemoval]);

  useLayoutEffect(() => {
    if (!isConfirmingRemoval && restoreRemoveFocus.current) {
      restoreRemoveFocus.current = false;
      removeButtonRef.current?.focus();
    }
  }, [isConfirmingRemoval]);

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
      data-testid="shopping-item"
      data-item-id={item.id}
      aria-busy={busy || undefined}
      onTouchStart={(event) => {
        swipeStart.current = null;
        if (busy || isEditingNote || isConfirmingRemoval || event.touches.length !== 1) return;
        if ((event.target as Element).closest('button, input, a')) return;
        const touch = event.touches[0];
        swipeStart.current = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
      }}
      onTouchCancel={() => {
        swipeStart.current = null;
      }}
      onTouchEnd={(event) => {
        const start = swipeStart.current;
        swipeStart.current = null;
        if (!start || busy || event.touches.length !== 0) return;
        const touch = Array.from(event.changedTouches).find(
          (entry) => entry.identifier === start.id
        );
        if (!touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (dx <= -60 && Math.abs(dx) > Math.abs(dy) * 2) setIsConfirmingRemoval(true);
      }}
      className={cn(
        'relative group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1 min-h-14 px-2 py-1 rounded-xl bg-white border border-border/50 shadow-sm transition-colors',
        item.isPurchased && 'bg-green-50/80 border-green-100',
        view === 'grid' && 'px-1',
        view === 'grid' && isNoteExpanded && 'col-span-full',
        busy && 'ring-2 ring-primary/40'
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
          <LocalizedName
            names={namesOf(item.product)}
            locale={locale}
            // The list row's big line is 20px; the wrapper must not add a 24px strut above it,
            // so a note row with an English line stays within the 64px compact row.
            className={cn('min-w-0', view === 'list' && 'leading-5')}
            primaryClassName={cn(
              'font-bold text-base leading-5 truncate transition-all duration-300',
              view === 'grid' && 'text-xs leading-4',
              item.isPurchased ? 'line-through text-muted-foreground' : 'text-foreground'
            )}
            secondaryClassName={cn(
              'truncate',
              view === 'list' && 'leading-3',
              item.isPurchased && 'line-through'
            )}
          />
          {item.variant?.name && (
            <span className="max-w-1/2 truncate text-[10px] bg-secondary/10 text-secondary-foreground px-1.5 py-0.5 rounded-full font-bold">
              <LocalizedName names={namesOf(item.variant)} locale={locale} />
            </span>
          )}
        </div>
      </div>

      {/* Right side actions */}
      <div
        inert={isConfirmingRemoval}
        aria-hidden={isConfirmingRemoval || undefined}
        className={cn(
          'col-start-3 row-start-1 row-span-2 flex items-center',
          view === 'grid' && 'grid grid-cols-[24px_44px] grid-rows-2'
        )}
      >
        {onUpdateNote && !isEditingNote && !item.isPurchased && (
          <button
            type="button"
            disabled={busy}
            aria-label={t('item.editNote', { name: productName })}
            onClick={(e) => {
              e.stopPropagation();
              setIsEditingNote(true);
            }}
            className="flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-primary hover:bg-primary/5 rounded-full transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <MessageSquarePlus size={16} />
          </button>
        )}

        <button
          type="button"
          ref={removeButtonRef}
          disabled={busy}
          aria-label={t('item.remove', { name: productName })}
          onClick={(e) => {
            e.stopPropagation();
            setIsConfirmingRemoval(true);
          }}
          className={cn(
            'flex items-center justify-center w-6 h-6 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 rounded-full transition-colors disabled:opacity-50 disabled:pointer-events-none',
            view === 'grid' && 'col-start-1 row-start-2'
          )}
        >
          <X size={14} className="hidden sm:block" />
          <MoreHorizontal size={16} className="sm:hidden" />
        </button>

        <button
          type="button"
          ref={toggleButtonRef}
          disabled={busy}
          onFocus={onToggleFocus}
          aria-label={t('item.purchased', { name: productName })}
          aria-pressed={item.isPurchased}
          onClick={() => onToggle(item.id)}
          className={cn(
            'flex items-center justify-center min-w-11 min-h-11 rounded-full cursor-pointer touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60',
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
          inert={isConfirmingRemoval}
          aria-hidden={isConfirmingRemoval || undefined}
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

      {isConfirmingRemoval && (
        <div
          role="group"
          aria-label={t('item.removeConfirm')}
          className="absolute inset-0 z-20 flex items-center justify-end gap-2 rounded-xl bg-white px-2 shadow-md"
        >
          <span className="mr-auto text-sm font-semibold">{t('item.removeConfirm')}</span>
          <button
            ref={cancelRemovalRef}
            type="button"
            className="min-h-11 px-2 text-sm"
            onClick={() => {
              restoreRemoveFocus.current = true;
              setIsConfirmingRemoval(false);
            }}
          >
            {t('item.removeCancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            className="min-h-11 rounded-lg bg-red-600 px-3 text-sm text-white disabled:opacity-50"
            onClick={() => {
              setIsConfirmingRemoval(false);
              void onRemove(item.id);
            }}
          >
            {t('item.removeConfirmAction')}
          </button>
        </div>
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
            aria-label={t('item.editNote', { name: productName })}
            className="min-w-0 flex-1 px-2 py-2 text-sm bg-muted border-none rounded-xl focus:ring-2 focus:ring-primary outline-none disabled:opacity-60"
            autoFocus
          />
          <button
            type="button"
            disabled={editorDisabled}
            className="px-2 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-xl disabled:opacity-60"
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
