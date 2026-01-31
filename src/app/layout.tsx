import type { Metadata } from 'next';
import { Fredoka, Nunito } from 'next/font/google';
import './globals.css';
import Providers from '@/components/Providers';
import PwaRegister from '@/components/PwaRegister';
import MobileNav from '@/components/layout/MobileNav';
import UserMenu from '@/components/UserMenu';
import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';

const bodyFont = Nunito({
  variable: '--font-body',
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
});

const headingFont = Fredoka({
  variable: '--font-heading',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'Clickmoji Shop - Emoji Shopping List',
  description: 'Visual shopping list app using emoji instead of text',
  manifest: '/manifest.json',
  icons: {
    icon: '/icon.svg',
  },
};

export const viewport = {
  themeColor: '#4f46e5',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${bodyFont.variable} ${headingFont.variable} antialiased bg-background pb-20 sm:pb-0`}
      >
        <Providers>
          <PwaRegister />
          <header className="fixed top-0 left-0 right-0 h-16 bg-white/50 backdrop-blur-md z-40 px-4 flex items-center justify-between border-b border-border/50 sm:sticky">
            <Link href="/" className="flex items-center gap-2 cursor-pointer">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <ShoppingCart className="h-5 w-5" aria-hidden="true" />
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
      </body>
    </html>
  );
}
