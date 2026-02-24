'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShoppingCart, History, Star, Grid } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/lists', label: 'Списки', icon: ShoppingCart, emoji: '🛒' },
  { href: '/categories', label: 'Категории', icon: Grid, emoji: '📁' },
  { href: '/categories/favorites', label: 'Избранное', icon: Star, emoji: '⭐' },
  { href: '/history', label: 'История', icon: History, emoji: '📜' },
];

export default function MobileNav() {
  const pathname = usePathname();

  // Don't show nav on login/register pages
  if (['/login', '/register', '/forgot-password', '/reset-password'].includes(pathname)) {
    return null;
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-lg border-t border-border px-4 pb-safe-bottom z-50 sm:hidden">
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
              <span className="text-[10px] font-bold uppercase tracking-wider">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
