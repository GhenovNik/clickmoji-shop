'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import { ShoppingCart, History, Star, Grid, LogIn } from 'lucide-react';
import { cn } from '@/lib/utils';

const authenticatedNavItems = [
  { href: '/lists', label: 'lists', icon: ShoppingCart, emoji: '🛒' },
  { href: '/categories', label: 'categories', icon: Grid, emoji: '📁' },
  { href: '/categories/favorites', label: 'favorites', icon: Star, emoji: '⭐' },
  { href: '/history', label: 'history', icon: History, emoji: '📜' },
] as const;

const anonymousNavItems = [
  { href: '/categories', label: 'catalog', icon: Grid, emoji: '📁' },
  { href: '/login', label: 'login', icon: LogIn, emoji: '🔐' },
] as const;

export default function MobileNav() {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const { data: session } = useSession();
  const navItems = session?.user ? authenticatedNavItems : anonymousNavItems;

  // Don't show nav on login/register pages
  if (['/login', '/register', '/forgot-password', '/reset-password'].includes(pathname)) {
    return null;
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-lg border-t border-border px-4 pb-safe-bottom z-(--z-mobile-nav) sm:hidden">
      <div className="flex justify-between items-center h-16 max-w-md mx-auto">
        {navItems.map((item) => {
          const isFavoritesRoute = pathname.startsWith('/categories/favorites');
          const isCategoryRoute = pathname.startsWith('/categories');
          const isActive =
            item.href === '/categories'
              ? isCategoryRoute && !isFavoritesRoute
              : item.href === '/categories/favorites'
                ? isFavoritesRoute
                : pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex flex-col items-center justify-center flex-1 h-full gap-1 transition-all',
                isActive ? 'text-primary scale-110' : 'text-muted-foreground'
              )}
            >
              <div className="relative">
                <Icon size={24} strokeWidth={isActive ? 2.5 : 2} />
                {isActive && (
                  <div className="absolute -top-1 -right-1 w-2 h-2 bg-secondary rounded-full" />
                )}
              </div>
              <span className="text-[10px] font-bold uppercase tracking-wider">
                {t(item.label)}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
