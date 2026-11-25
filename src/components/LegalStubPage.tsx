'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

type LegalStubPageProps = {
  kind: 'terms' | 'privacy';
};

export default function LegalStubPage({ kind }: LegalStubPageProps) {
  const t = useTranslations('legal');
  const otherKind = kind === 'terms' ? 'privacy' : 'terms';
  const otherHref = kind === 'terms' ? '/privacy' : '/terms';

  return (
    <div className="py-8 sm:py-12">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-primary hover:text-primary/80 font-medium text-sm sm:text-base"
          >
            <span aria-hidden="true">←</span>
            <span>{t('stub.backHome')}</span>
          </Link>
        </div>

        <article className="bg-card border border-border rounded-3xl shadow-soft p-6 sm:p-8 space-y-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t(`${kind}.subtitle`)}
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground font-heading">
              {t(`${kind}.title`)}
            </h1>
          </div>

          <div className="inline-flex items-center rounded-full bg-muted px-3.5 py-1.5 text-sm font-semibold text-foreground">
            {t('stub.badge')}
          </div>

          <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
            {t('stub.note')}
          </p>

          <div className="pt-2 border-t border-border/70 flex flex-wrap items-center justify-between gap-3 text-sm">
            <Link
              href={otherHref}
              className="text-primary hover:text-primary/80 font-medium underline-offset-4 hover:underline"
            >
              {t(`links.${otherKind}`)}
            </Link>
            <Link
              href="/"
              className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
            >
              {t('stub.backHome')}
            </Link>
          </div>
        </article>
      </div>
    </div>
  );
}
