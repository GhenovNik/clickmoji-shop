'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { listsQueryKey, useActiveList } from '@/hooks/useListsQuery';

type SearchProduct = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  variants?: { id: string; name: string; nameEn: string; emoji: string }[];
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

const addProductToListAPI = async (
  listId: string,
  productId: string,
  variantId?: string | null
) => {
  const res = await fetch(`/api/lists/${listId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ productId, variantId: variantId || null }],
    }),
  });
  if (!res.ok) throw new Error('Failed to add product');
  return res.json();
};

const createSmartProductAPI = async (productName: string) => {
  const res = await fetch('/api/products/smart-create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productName }),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to create product');
  }
  return res.json();
};

export default function ProductSearch() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string | null>>({});
  const searchRef = useRef<HTMLDivElement>(null);
  const { activeListId } = useActiveList();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = useSession();

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
    mutationFn: ({
      listId,
      productId,
      variantId,
    }: {
      listId: string;
      productId: string;
      variantId?: string | null;
    }) => addProductToListAPI(listId, productId, variantId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: listsQueryKey });
      queryClient.invalidateQueries({ queryKey: ['list', variables.listId] });
    },
  });

  const handleAddProduct = async (product: SearchProduct) => {
    if (!session?.user) {
      router.push('/login');
      return;
    }

    if (!activeListId) {
      alert('Сначала выберите список покупок');
      return;
    }

    try {
      const variantId = selectedVariants[product.id] || product.variants?.[0]?.id || null;

      const result = await addProductMutation.mutateAsync({
        listId: activeListId,
        productId: product.id,
        variantId,
      });

      // Successfully added (duplicates are now allowed)
      if (result.createdItems && result.createdItems.length > 0) {
        alert(`${product.emoji} ${product.name} добавлен в список!`);
      }

      setQuery('');
      setDebouncedQuery('');
      setIsOpen(false);
      setSelectedVariants({});

      // Redirect to the list page
      router.push(`/lists/${activeListId}`);
    } catch (error) {
      console.error('Error adding product:', error);
      alert('Ошибка при добавлении товара');
    }
  };

  const handleCreateWithAI = async () => {
    if (!session?.user) {
      router.push('/login');
      return;
    }

    if (!activeListId) {
      alert('Сначала выберите список покупок');
      return;
    }

    if (!query.trim()) {
      return;
    }

    setIsCreating(true);

    try {
      // Create product with AI
      const createResult = await createSmartProductAPI(query.trim());

      // Add product to list
      await addProductMutation.mutateAsync({
        listId: activeListId,
        productId: createResult.product.id,
      });

      // Product successfully added (duplicates are now allowed)
      if (createResult.exists) {
        // Product existed, was successfully added
        alert(
          `${createResult.product.emoji} ${createResult.product.name} найден и добавлен в список!`
        );
      } else {
        // Product was created and added
        let message = `${createResult.product.emoji} ${createResult.product.name} создан с помощью AI и добавлен в список!`;
        if (createResult.customEmojiGenerated) {
          message += '\n🎨 С уникальным AI-изображением!';
        }
        alert(message);
      }

      setQuery('');
      setDebouncedQuery('');
      setIsOpen(false);
      setSelectedVariants({});
      router.push(`/lists/${activeListId}`);
    } catch (error) {
      console.error('Error creating product with AI:', error);
      alert(
        error instanceof Error
          ? error.message
          : 'Ошибка при создании товара. Попробуйте позже или обратитесь к администратору.'
      );
    } finally {
      setIsCreating(false);
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
            <div className="p-4">
              <p className="text-center text-gray-500 mb-3">Ничего не найдено</p>
              <button
                onClick={handleCreateWithAI}
                disabled={isCreating || !query.trim()}
                className="w-full bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white px-4 py-3 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isCreating ? (
                  <>
                    <span className="animate-spin">⏳</span>
                    <span>Создание (5-10 сек)...</span>
                  </>
                ) : (
                  <>
                    <span>✨</span>
                    <span>Создать через AI</span>
                  </>
                )}
              </button>
              <p className="text-xs text-gray-400 mt-2 text-center">
                AI определит категорию и подберёт значок
                <br />
                Для специфичных товаров сгенерирует уникальное изображение
              </p>
            </div>
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
                    <Image
                      src={product.imageUrl}
                      alt={product.name}
                      width={48}
                      height={48}
                      className="w-12 h-12 object-contain"
                    />
                  ) : (
                    <span className="text-3xl">{product.emoji}</span>
                  )}
                  <div className="flex-1 text-left">
                    <p className="font-medium text-gray-900">{product.name}</p>
                    <p className="text-sm text-gray-500 flex items-center gap-1">
                      {product.category.isCustom && product.category.imageUrl ? (
                        <Image
                          src={product.category.imageUrl}
                          alt=""
                          width={20}
                          height={20}
                          className="w-5 h-5 object-contain inline-block"
                        />
                      ) : (
                        <span>{product.category.emoji}</span>
                      )}
                      <span>{product.category.name}</span>
                    </p>
                    {product.variants && product.variants.length > 0 && (
                      <div className="mt-2">
                        <select
                          value={selectedVariants[product.id] || ''}
                          onChange={(event) => {
                            event.stopPropagation();
                            setSelectedVariants((current) => ({
                              ...current,
                              [product.id]: event.target.value || null,
                            }));
                          }}
                          onClick={(event) => event.stopPropagation()}
                          className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-900"
                        >
                          <option value="">Без варианта</option>
                          {product.variants.map((variant) => (
                            <option key={variant.id} value={variant.id}>
                              {variant.emoji ? `${variant.emoji} ` : ''}
                              {variant.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
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
