'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { listsQueryKey, useActiveList } from '@/hooks/useListsQuery';
import { queryKeys } from '@/lib/query-keys';
import { localizedName } from '@/lib/catalog-name';
import { productImageUrl } from '@/lib/product-image';

type SearchProduct = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  imageUrlEn?: string | null;
  variants?: { id: string; name: string; nameEn: string; emoji: string }[];
  category: {
    id: string;
    name: string;
    nameEn?: string | null;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
  };
};

const searchProductsAPI = async (query: string, locale: string): Promise<SearchProduct[]> => {
  if (!query.trim()) return [];
  // The language is sent explicitly, so a response always matches the key it is cached under.
  const res = await fetch(
    `/api/search?q=${encodeURIComponent(query)}&locale=${encodeURIComponent(locale)}`
  );
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
  const [addError, setAddError] = useState('');
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string | null>>({});
  const searchRef = useRef<HTMLDivElement>(null);
  const { activeListId } = useActiveList();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const t = useTranslations('catalog');
  const locale = useLocale();

  // Debounce query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  // Search query
  const { data: results = [], isLoading } = useQuery({
    queryKey: queryKeys.searchQuery(debouncedQuery, locale),
    queryFn: () => searchProductsAPI(debouncedQuery, locale),
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
      queryClient.invalidateQueries({ queryKey: queryKeys.list(variables.listId) });
    },
  });

  const handleAddProduct = async (product: SearchProduct) => {
    setAddError('');
    if (!session?.user) {
      router.push('/login');
      return;
    }

    if (!activeListId) {
      setAddError(t('shared.selectListFirst'));
      return;
    }

    try {
      const variantId = selectedVariants[product.id] || product.variants?.[0]?.id || null;

      await addProductMutation.mutateAsync({
        listId: activeListId,
        productId: product.id,
        variantId,
      });

      setQuery('');
      setDebouncedQuery('');
      setIsOpen(false);
      setSelectedVariants({});

      // Redirect to the list page
      router.push(`/lists/${activeListId}`);
    } catch (error) {
      console.error('Error adding product:', error);
      setAddError(t('shared.addProductFailed'));
    }
  };

  const handleCreateWithAI = async () => {
    setAddError('');
    if (!session?.user) {
      router.push('/login');
      return;
    }

    if (!activeListId) {
      setAddError(t('shared.selectListFirst'));
      return;
    }

    if (!query.trim()) {
      return;
    }

    setIsCreating(true);
    let productCreated = false;

    try {
      // Create product with AI
      const createResult = await createSmartProductAPI(query.trim());
      productCreated = true;

      // Add product to list
      await addProductMutation.mutateAsync({
        listId: activeListId,
        productId: createResult.product.id,
      });

      setQuery('');
      setDebouncedQuery('');
      setIsOpen(false);
      setSelectedVariants({});
      router.push(`/lists/${activeListId}`);
    } catch (error) {
      console.error('Error creating product with AI:', error);
      setAddError(
        productCreated
          ? t('shared.addProductFailed')
          : error instanceof Error
            ? error.message
            : t('search.createFailed')
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
          placeholder={t('search.placeholder')}
          className="w-full px-4 py-3 pr-10 rounded-xl border-2 border-gray-300 focus:border-blue-500 focus:outline-none text-gray-900"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</div>
      </div>

      {addError && (
        <p role="alert" className="text-red-500 text-sm mt-2">
          {addError}
        </p>
      )}

      {/* Results Dropdown */}
      {isOpen && (
        <div className="absolute z-10 w-full mt-2 bg-white rounded-xl shadow-lg max-h-96 overflow-y-auto">
          {isLoading ? (
            <div className="p-4 text-center text-gray-500">{t('search.searching')}</div>
          ) : results.length === 0 ? (
            <div className="p-4">
              <p className="text-center text-gray-500 mb-3">{t('search.noResults')}</p>
              <button
                onClick={handleCreateWithAI}
                disabled={isCreating || !query.trim()}
                className="w-full bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white px-4 py-3 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isCreating ? (
                  <>
                    <span className="animate-spin">⏳</span>
                    <span>{t('search.creating')}</span>
                  </>
                ) : (
                  <>
                    <span>✨</span>
                    <span>{t('search.createWithAi')}</span>
                  </>
                )}
              </button>
              <p className="text-xs text-gray-400 mt-2 text-center">
                {t('search.aiHintCategory')}
                <br />
                {t('search.aiHintImage')}
              </p>
            </div>
          ) : (
            <div className="py-2">
              {results.map((product) => {
                const name = localizedName(product, locale);
                const imageUrl = productImageUrl(product, locale);
                return (
                  <button
                    key={product.id}
                    onClick={() => handleAddProduct(product)}
                    disabled={addProductMutation.isPending}
                    className="w-full px-4 py-3 hover:bg-gray-100 flex items-center gap-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {product.isCustom && imageUrl ? (
                      <Image
                        src={imageUrl}
                        alt={name}
                        width={48}
                        height={48}
                        className="w-12 h-12 object-contain"
                      />
                    ) : (
                      <span className="text-3xl">{product.emoji}</span>
                    )}
                    <div className="flex-1 text-left">
                      <p className="font-medium text-gray-900">{name}</p>
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
                        <span>{localizedName(product.category, locale)}</span>
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
                            <option value="">{t('shared.noVariant')}</option>
                            {product.variants.map((variant) => (
                              <option key={variant.id} value={variant.id}>
                                {variant.emoji ? `${variant.emoji} ` : ''}
                                {localizedName(variant, locale)}
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
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
