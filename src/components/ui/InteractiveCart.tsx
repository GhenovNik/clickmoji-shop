'use client';

import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';

type ItemState = 'floating' | 'flying' | 'in-cart';

interface CartItem {
  id: number;
  emoji: string;
  initialPos: { top: string; left: string; right?: string };
  delay: string;
  state: ItemState;
}

const INITIAL_EMOJIS: CartItem[] = [
  {
    id: 1,
    emoji: '🍎',
    initialPos: { top: '-25px', left: '-50px' },
    delay: '0s',
    state: 'floating',
  },
  {
    id: 2,
    emoji: '🥖',
    initialPos: { top: '-65px', left: '10px' },
    delay: '0.2s',
    state: 'floating',
  },
  {
    id: 3,
    emoji: '🥛',
    initialPos: { top: '-25px', right: '-50px', left: 'auto' },
    delay: '0.4s',
    state: 'floating',
  },
];

export default function InteractiveCart() {
  const [items, setItems] = useState<CartItem[]>(INITIAL_EMOJIS);
  const cartRef = useRef<HTMLDivElement>(null);
  const [centerPos, setCenterPos] = useState({ top: '30px', left: '30px' });

  // Update target center position on mount
  useEffect(() => {
    if (cartRef.current) {
      setCenterPos({
        top: '25px', // Fly towards the center opening of the cart
        left: '30px',
      });
    }
  }, []);

  const handleDrop = (id: number) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, state: 'flying' } : item)));

    setTimeout(() => {
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, state: 'in-cart' } : item))
      );
    }, 400);
  };

  const resetCart = () => {
    setItems((prev) => prev.map((item) => ({ ...item, state: 'floating' })));
  };

  const inCartCount = items.filter((i) => i.state === 'in-cart').length;
  const isFull = inCartCount === items.length;

  return (
    <div className="relative inline-flex items-center justify-center mb-8 mt-10 w-28 h-28">
      {/* Cart Button */}
      <div
        ref={cartRef}
        onClick={isFull ? resetCart : undefined}
        className={cn(
          'absolute inset-0 flex flex-col items-center justify-center z-30 transition-all duration-300',
          isFull ? 'cursor-pointer hover:scale-105 hover:-rotate-3' : 'hover:rotate-0 -rotate-3',
          inCartCount > 0 && !isFull && 'scale-105 rotate-0',
          isFull && 'scale-110 rotate-0'
        )}
        title={isFull ? 'Очистить корзину' : ''}
      >
        {/* Container for products in the cart. 
            It needs to be placed absolutely to visually overlap the top part of the cart emoji 
            but sit behind the front bars. Since emoji is a single font glyph, we use a clipping/layer trick 
            by positioning it carefully in the top-right area of the cart */}
        <div className="absolute right-3 top-4 flex -space-x-4 z-20">
          {items.map(
            (item) =>
              item.state === 'in-cart' && (
                <span
                  key={`incart-${item.id}`}
                  className="text-3xl transition-all duration-300 animate-in"
                  style={{ animation: 'bounce 0.5s' }}
                >
                  {item.emoji}
                </span>
              )
          )}
        </div>

        {/* Big Cart Emoji - Z-index must be higher so the base of the cart covers the bottom of the items */}
        <span className="text-7xl sm:text-8xl relative z-40 transition-transform drop-shadow-[0_4px_8px_rgba(0,0,0,0.15)] select-none">
          🛒
        </span>
      </div>

      {/* Container for absolute floating emojis. Put it BEHIND the cart visually for dropping, 
          but with pointer-events-auto for clicking when floating */}
      <div className="absolute inset-0 z-20 pointer-events-none">
        {items.map((item) => {
          if (item.state === 'in-cart') return null;

          const isFlying = item.state === 'flying';

          return (
            <div
              key={item.id}
              onClick={() => !isFlying && handleDrop(item.id)}
              className={cn(
                'absolute text-4xl cursor-pointer select-none transition-transform pointer-events-auto',
                !isFlying && 'animate-bounce hover:scale-125 hover:-rotate-12 z-40', // In front when floating
                isFlying && 'z-10' // Drop BEHIND the cart when flying
              )}
              style={{
                top: isFlying ? centerPos.top : item.initialPos.top,
                left: isFlying ? centerPos.left : item.initialPos.left,
                right: isFlying ? 'auto' : item.initialPos.right,
                opacity: isFlying ? 0 : 1,
                transform: isFlying ? 'scale(0.1)' : 'scale(1)',
                transition: isFlying ? 'all 400ms cubic-bezier(0.25, 1, 0.5, 1)' : 'transform 0.2s',
                animationDelay: item.delay,
              }}
              title="Добавить в корзину!"
            >
              {item.emoji}
            </div>
          );
        })}
      </div>
    </div>
  );
}
