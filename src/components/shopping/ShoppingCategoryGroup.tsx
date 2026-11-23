'use client';

import { useId, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { Item } from '@/hooks/useShoppingListItems';
import type { ShoppingView } from '@/hooks/useShoppingListPresentation';
import { localizedName } from '@/lib/catalog-name';
import { cn } from '@/lib/utils';

type Props = {
  category: Item['product']['category'];
  count: number;
  expanded: boolean;
  onToggle: () => void;
  view: ShoppingView;
  purchased: boolean;
  children: ReactNode;
};

export default function ShoppingCategoryGroup({
  category,
  count,
  expanded,
  onToggle,
  view,
  purchased,
  children,
}: Props) {
  const id = useId();
  const locale = useLocale();
  const t = useTranslations('lists');
  const Chevron = expanded ? ChevronUp : ChevronDown;

  return (
    <section className={cn('rounded-xl p-0.5 bg-indigo-100/60', purchased && 'bg-green-100/50')}>
      <h3>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          title={t(expanded ? 'listPage.collapseGroup' : 'listPage.expandGroup')}
          onClick={onToggle}
          className="flex w-full items-center gap-2 min-h-6 px-1 text-left text-sm font-medium text-gray-700 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span className="text-lg leading-6">{category.emoji}</span>{' '}
          <span className="min-w-0 flex-1 truncate">
            {localizedName(category, locale)} ({count})
          </span>
          <Chevron size={18} aria-hidden="true" />
        </button>
      </h3>
      <div
        id={id}
        className={cn('grid items-start gap-1', view === 'grid' && 'grid-cols-2 md:grid-cols-3')}
      >
        {expanded && children}
      </div>
    </section>
  );
}
