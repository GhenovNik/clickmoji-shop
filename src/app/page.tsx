import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import ProductShowcase, {
  type ScreenId,
  type ShowcaseScreen,
} from '@/components/landing/ProductShowcase';

const SCREEN_IDS: readonly ScreenId[] = ['cards', 'list', 'grid'];

export default async function Home() {
  const [locale, t] = await Promise.all([getLocale(), getTranslations('home')]);
  const imageLocale = locale === 'ru' ? 'ru' : 'en';

  const screens: ShowcaseScreen[] = SCREEN_IDS.map((id) => ({
    id,
    alt: t(`showcase.${id}.alt`),
    title: t(`showcase.${id}.title`),
    caption: t(`showcase.${id}.caption`),
  }));

  return (
    <div className="py-6 sm:py-10 space-y-8 sm:space-y-12">
      <section className="max-w-2xl mx-auto text-center space-y-4 sm:space-y-5">
        <h1 className="text-3xl sm:text-5xl md:text-[3.25rem] font-black text-foreground tracking-tight leading-[1.1] font-heading">
          {t.rich('hero.title', {
            brand: (chunks) => <span className="text-primary">{chunks}</span>,
          })}
        </h1>

        <p className="text-base sm:text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
          {t('hero.subtitle')}
        </p>

        <div className="pt-1">
          <Link
            href="/categories"
            className="inline-flex w-full sm:w-auto items-center justify-center gap-2.5 min-h-12 bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-3.5 rounded-2xl font-bold text-base sm:text-lg shadow-soft hover:shadow-clay active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 group"
          >
            <span>{t('actions.start')}</span>
            <ArrowRight
              className="w-5 h-5 group-hover:translate-x-1 transition-transform"
              aria-hidden="true"
            />
          </Link>
        </div>
      </section>

      <ProductShowcase locale={imageLocale} heading={t('showcase.heading')} screens={screens} />
    </div>
  );
}
