'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLists } from '@/store/lists';
import { useRouter } from 'next/navigation';

type SearchProduct = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  category: {
    id: string;
    name: string;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
  };
};

const searchProductsAPI = async (query: string): Promise<SearchProduct[]> => {
  if (!query.trim()) return [];
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error('Search failed');
  return res.json();
};

const addProductToListAPI = async (listId: string, productId: string) => {
  const res = await fetch(`/api/lists/${listId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ productId }],
    }),
  });
  if (!res.ok) throw new Error('Failed to add product');
  return res.json();
};

export default function ProductSearch() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const { activeListId, setLists } = useLists();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Debounce query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  // Search query
  const { data: results = [], isLoading } = useQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: () => searchProductsAPI(debouncedQuery),
    enabled: debouncedQuery.trim().length > 0,
  });

  // Show dropdown when there are results or loading
  useEffect(() => {
    if (debouncedQuery.trim().length > 0) {
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  }, [debouncedQuery, results]);

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

  const addProductMutation = useMutation({
    mutationFn: ({ listId, productId }: { listId: string; productId: string }) =>
      addProductToListAPI(listId, productId),
    onSuccess: async (_, variables) => {
      // Refresh lists
      const listsResponse = await fetch('/api/lists');
      if (listsResponse.ok) {
        const listsData = await listsResponse.json();
        setLists(listsData);
      }

      // Invalidate list query to refresh item count
      queryClient.invalidateQueries({ queryKey: ['list', variables.listId] });
    },
  });

  const handleAddProduct = async (product: SearchProduct) => {
    // Get fresh activeListId at click time
    const currentActiveListId = useLists.getState().activeListId;

    if (!currentActiveListId) {
      alert('Сначала выберите список покупок');
      return;
    }

    try {
      const result = await addProductMutation.mutateAsync({
        listId: currentActiveListId,
        productId: product.id,
      });

      setQuery('');
      setDebouncedQuery('');
      setIsOpen(false);

      // Redirect to the list page immediately
      // Alert messages are shown there if needed
      router.push(`/lists/${currentActiveListId}`);
    } catch (error) {
      console.error('Error adding product:', error);
      alert('Ошибка при добавлении товара');
    }
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
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</div>
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
                  disabled={addProductMutation.isPending}
                  className="w-full px-4 py-3 hover:bg-gray-100 flex items-center gap-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {product.isCustom && product.imageUrl ? (
                    <img
                      src={product.imageUrl}
                      alt={product.name}
                      className="w-12 h-12 object-contain"
                    />
                  ) : (
                    <span className="text-3xl">{product.emoji}</span>
                  )}
                  <div className="flex-1 text-left">
                    <p className="font-medium text-gray-900">{product.name}</p>
                    <p className="text-sm text-gray-500 flex items-center gap-1">
                      {product.category.isCustom && product.category.imageUrl ? (
                        <img
                          src={product.category.imageUrl}
                          alt=""
                          className="w-5 h-5 object-contain inline-block"
                        />
                      ) : (
                        <span>{product.category.emoji}</span>
                      )}
                      <span>{product.category.name}</span>
                    </p>
                  </div>
                  <span className="text-green-600 font-semibold">
                    {addProductMutation.isPending ? '⏳' : '+'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
