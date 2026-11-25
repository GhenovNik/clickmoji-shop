'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

type LegalLinksProps = {
  className?: string;
  linkClassName?: string;
};

export default function LegalLinks({ className, linkClassName }: LegalLinksProps) {
  const t = useTranslations('legal.links');

  return (
    <div
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm', className)}
    >
      <Link
        href="/terms"
        className={cn(
          'text-muted-foreground hover:text-foreground underline-offset-4 hover:underline transition-colors',
          linkClassName
        )}
      >
        {t('terms')}
      </Link>
      <span aria-hidden="true" className="text-muted-foreground/60">
        {t('separator')}
      </span>
      <Link
        href="/privacy"
        className={cn(
          'text-muted-foreground hover:text-foreground underline-offset-4 hover:underline transition-colors',
          linkClassName
        )}
      >
        {t('privacy')}
      </Link>
    </div>
  );
}
