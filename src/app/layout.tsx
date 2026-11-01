import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { Rubik, Nunito } from 'next/font/google';
import './globals.css';
import Providers from '@/components/Providers';
import PwaRegister from '@/components/PwaRegister';
import MobileNav from '@/components/layout/MobileNav';
import UserMenu from '@/components/UserMenu';
import Link from 'next/link';
import { Home } from 'lucide-react';

const bodyFont = Nunito({
  variable: '--font-body',
  subsets: ['latin', 'cyrillic'],
  weight: ['300', '400', '500', '600', '700'],
});

const headingFont = Rubik({
  variable: '--font-heading',
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700', '800', '900'],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://clickmoji-shop.vercel.app'),
  applicationName: 'Clickmoji Shop',
  title: {
    default: 'Clickmoji Shop - Visual Shopping Lists',
    template: '%s | Clickmoji Shop',
  },
  description:
    'A mobile-first shopping list app with emoji-based product selection and AI-assisted catalog tools.',
  manifest: '/manifest.json',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'Clickmoji Shop',
    title: 'Clickmoji Shop - Visual Shopping Lists',
    description:
      'Build and manage shopping lists with visual product selection, favorites, history, and AI-assisted catalog tools.',
    locale: 'en_US',
    alternateLocale: ['ru_RU'],
  },
  twitter: {
    card: 'summary',
    title: 'Clickmoji Shop - Visual Shopping Lists',
    description: 'A mobile-first, emoji-first shopping list application.',
  },
  icons: {
    icon: '/icon.svg',
  },
};

export const viewport = {
  themeColor: '#4f46e5',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [locale, t] = await Promise.all([getLocale(), getTranslations('nav')]);

  return (
    <html lang={locale}>
      <body
        className={`${bodyFont.variable} ${headingFont.variable} antialiased bg-background pb-20 sm:pb-0`}
      >
        <NextIntlClientProvider>
          <Providers>
            <PwaRegister />
            <header className="fixed top-0 left-0 right-0 h-16 bg-white/50 backdrop-blur-md z-40 px-4 flex items-center justify-between border-b border-border/50 sm:sticky">
              <Link
                href="/"
                aria-label={t('home')}
                className="flex items-center gap-2 cursor-pointer"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Home className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="font-heading font-bold text-xl tracking-tight hidden xs:block">
                  ClickMoji
                </span>
              </Link>
              <UserMenu />
            </header>
            <main className="pt-20 px-4 max-w-7xl mx-auto min-h-screen">{children}</main>
            <MobileNav />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
