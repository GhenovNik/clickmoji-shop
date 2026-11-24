import Image, { type StaticImageData } from 'next/image';
import ruCards from '@/assets/landing/ru/product-cards.webp';
import ruList from '@/assets/landing/ru/shopping-list.webp';
import ruGrid from '@/assets/landing/ru/shopping-grid.webp';
import enCards from '@/assets/landing/en/product-cards.webp';
import enList from '@/assets/landing/en/shopping-list.webp';
import enGrid from '@/assets/landing/en/shopping-grid.webp';

export type ScreenId = 'cards' | 'list' | 'grid';

export interface ShowcaseScreen {
  id: ScreenId;
  alt: string;
  title: string;
  caption: string;
}

const SCREEN_IMAGES: Record<'ru' | 'en', Record<ScreenId, StaticImageData>> = {
  ru: { cards: ruCards, list: ruList, grid: ruGrid },
  en: { cards: enCards, list: enList, grid: enGrid },
};

interface ProductShowcaseProps {
  locale: 'ru' | 'en';
  heading: string;
  screens: ShowcaseScreen[];
}

// Displays real Clickmoji UI captures so visitors recognize the app immediately.
// Mobile cards cap at 272px (480w at 1.75x DPR) and prioritize only the first
// above-the-fold screenshot so LCP stays close to the text baseline on Slow 4G.
export default function ProductShowcase({ locale, heading, screens }: ProductShowcaseProps) {
  const images = SCREEN_IMAGES[locale];

  return (
    <section aria-label={heading} className="w-full max-w-5xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-7">
        {screens.map((screen, index) => (
          <figure
            key={screen.id}
            data-testid={`landing-screen-${screen.id}`}
            className="min-w-0 w-full max-w-[272px] mx-auto md:max-w-none"
          >
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft aspect-[3/4]">
              <Image
                src={images[screen.id]}
                alt={screen.alt}
                width={780}
                height={1040}
                sizes="(max-width: 767px) min(272px, calc(100vw - 2rem)), (max-width: 1055px) calc((100vw - 5.5rem) / 3), 322px"
                quality={45}
                preload={index === 0}
                loading={index === 0 ? 'eager' : 'lazy'}
                fetchPriority={index === 0 ? 'high' : 'low'}
                decoding={index === 0 ? 'sync' : 'async'}
                className="h-full w-full object-cover object-top"
              />
            </div>
            <figcaption className="mt-3 text-left md:text-center px-1">
              <h2 className="font-heading font-bold text-base sm:text-lg text-foreground leading-snug">
                {screen.title}
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed mt-0.5">
                {screen.caption}
              </p>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
