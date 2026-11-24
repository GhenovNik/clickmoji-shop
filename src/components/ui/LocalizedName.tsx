import type { ReactNode } from 'react';
import { namePair, type NamesByLocale } from '@/lib/catalog-name';
import { cn } from '@/lib/utils';

type LocalizedNameProps = {
  /** Names per language code; `ru` and `en` come from `namesOf(entity)`. */
  names: NamesByLocale;
  locale: string;
  /** Layout of the wrapper around both lines. */
  className?: string;
  /** Styling of the big line. */
  primaryClassName?: string;
  /** Styling of the small English line. */
  secondaryClassName?: string;
  /** Text appended to the big line, e.g. a count. */
  suffix?: ReactNode;
};

/**
 * Draws the name pair of `namePair`: the big name, and the small English line under it when the
 * rule asks for one. Every catalogue list, card and label uses it, so the rule lives in one place.
 */
export function LocalizedName({
  names,
  locale,
  className,
  primaryClassName,
  secondaryClassName,
  suffix,
}: LocalizedNameProps) {
  const { primary, primaryLang, secondary } = namePair(names, locale);
  return (
    <span className={cn('block min-w-0', className)}>
      <span lang={primaryLang} className={primaryClassName}>
        {primary}
        {suffix}
      </span>
      {secondary && (
        <span
          lang="en"
          className={cn('block text-xs text-gray-500 wrap-break-word', secondaryClassName)}
        >
          {secondary}
        </span>
      )}
    </span>
  );
}
