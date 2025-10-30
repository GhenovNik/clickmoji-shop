'use client';

import { useState, useEffect, useRef } from 'react';
import { useShoppingList } from '@/store/shopping-list';

type SearchProduct = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  category: {
    id: string;
    name: string;
    emoji: string;
  };
};

export default function ProductSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchProduct[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const addItems = useShoppingList((state) => state.addItems);

  // Debounce search
  useEffect(() => {
    if (query.trim().length === 0) {
      setResults([]);
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((res) => res.json())
        .then((data) => {
          setResults(data);
          setIsOpen(true);
          setIsLoading(false);
        })
        .catch((error) => {
          console.error('Search error:', error);
          setIsLoading(false);
        });
    }, 300); // 300ms debounce

    return () => clearTimeout(timer);
  }, [query]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleAddProduct = (product: SearchProduct) => {
    addItems([
      {
        productId: product.id,
        name: product.name,
        emoji: product.emoji,
        categoryName: product.category.name,
      },
    ]);
    setQuery('');
    setResults([]);
    setIsOpen(false);

    // Show a brief success message
    alert(`${product.emoji} ${product.name} добавлен в список!`);
  };

  return (
    <div ref={searchRef} className="relative w-full max-w-md mx-auto">
      {/* Search Input */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск товаров..."
          className="w-full px-4 py-3 pr-10 rounded-xl border-2 border-gray-300 focus:border-blue-500 focus:outline-none text-gray-900"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
          🔍
        </div>
      </div>

      {/* Results Dropdown */}
      {isOpen && (
        <div className="absolute z-10 w-full mt-2 bg-white rounded-xl shadow-lg max-h-96 overflow-y-auto">
          {isLoading ? (
            <div className="p-4 text-center text-gray-500">Поиск...</div>
          ) : results.length === 0 ? (
            <div className="p-4 text-center text-gray-500">Ничего не найдено</div>
          ) : (
            <div className="py-2">
              {results.map((product) => (
                <button
                  key={product.id}
                  onClick={() => handleAddProduct(product)}
                  className="w-full px-4 py-3 hover:bg-gray-100 flex items-center gap-3 transition-colors"
                >
                  <span className="text-3xl">{product.emoji}</span>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-gray-900">{product.name}</p>
                    <p className="text-sm text-gray-500">
                      {product.category.emoji} {product.category.name}
                    </p>
                  </div>
                  <span className="text-green-600 font-semibold">+</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
