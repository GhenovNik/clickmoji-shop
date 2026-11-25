'use client';

import { useTranslations } from 'next-intl';
import LegalLinks from '@/components/LegalLinks';

export default function SiteFooter() {
  const t = useTranslations('legal.footer');

  return (
    <footer className="border-t border-border/60 bg-background/80">
      <div className="max-w-7xl mx-auto px-safe-4 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs sm:text-sm text-muted-foreground">
        <span>{t('brand')}</span>
        <LegalLinks />
      </div>
    </footer>
  );
}
