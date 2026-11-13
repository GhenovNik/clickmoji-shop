'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { listsQueryKey, useActiveList } from './useListsQuery';
import { queryKeys } from '@/lib/query-keys';
import { refreshQueryCache } from '@/lib/refresh-query-cache';

export type Product = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  imageUrlEn?: string | null;
  variants?: {
    id: string;
    name: string;
    nameEn: string;
    emoji: string;
    imageUrl?: string | null;
    imageUrlEn?: string | null;
  }[];
  category: {
    id: string;
    name: string;
    nameEn?: string | null;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
  };
};

// API functions
const fetchProductsByCategoryAPI = async (categoryId: string): Promise<Product[]> => {
  const res = await fetch(`/api/products?categoryId=${categoryId}`);
  if (!res.ok) throw new Error('Failed to fetch products');
  return res.json();
};

const fetchFavoritesAPI = async () => {
  const res = await fetch('/api/favorites');
  if (!res.ok) throw new Error('Failed to fetch favorites');
  return res.json();
};

type FavoriteTarget = { productId: string } | { variantId: string };

const addFavoriteAPI = async (target: FavoriteTarget) => {
  const res = await fetch('/api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
  if (!res.ok) throw new Error('Failed to add favorite');
  return res.json();
};

const removeFavoriteAPI = async (target: FavoriteTarget) => {
  const params = new URLSearchParams(target as Record<string, string>);
  const res = await fetch(`/api/favorites?${params}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to remove favorite');
  return res.json();
};

// A guest marks products, signs in, and lands back here; the marks live under this key in
// sessionStorage just long enough for the round trip.
const selectionStorageKey = (categoryId: string) => `product-selection:${categoryId}`;

type SavedSelection = { products: string[]; variants: Record<string, string> };

function readSavedSelection(raw: string | null): SavedSelection | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { products, variants } = parsed as { products?: unknown; variants?: unknown };
  if (!Array.isArray(products) || products.some((id) => typeof id !== 'string')) return null;
  const cleanVariants: Record<string, string> = {};
  if (variants !== undefined) {
    if (typeof variants !== 'object' || variants === null || Array.isArray(variants)) return null;
    for (const [productId, variantId] of Object.entries(variants)) {
      if (typeof variantId !== 'string') return null;
      cleanVariants[productId] = variantId;
    }
  }
  return { products, variants: cleanVariants };
}

const addToListAPI = async (
  listId: string,
  items: { productId: string; variantId?: string | null }[]
) => {
  const res = await fetch(`/api/lists/${listId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error('Failed to add items to list');
  return res.json();
};

export function useProductSelection(categoryId: string) {
  const router = useRouter();
  const { data: session } = useSession();
  const { activeListId } = useActiveList();
  const queryClient = useQueryClient();
  const t = useTranslations('catalog.shared');

  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string | null>>({});
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const addPending = useRef(false);
  const restoredRef = useRef(false);

  // Query for products by category
  const {
    data: products = [],
    isLoading: loading,
    isError: productsError,
  } = useQuery({
    queryKey: queryKeys.categoryProducts(categoryId),
    queryFn: () => fetchProductsByCategoryAPI(categoryId),
    enabled: !!categoryId,
  });

  // Restore the guest's marks once, after the catalogue arrives; anything the catalogue no
  // longer has is dropped, and the stored copy is deleted either way.
  // A failed catalogue load must not consume the stored marks: they stay in storage for the
  // next mount instead of being dropped by a restore against an empty catalogue.
  useEffect(() => {
    if (restoredRef.current || !categoryId || loading || productsError) return;
    restoredRef.current = true;
    const key = selectionStorageKey(categoryId);
    let saved: SavedSelection | null = null;
    try {
      saved = readSavedSelection(window.sessionStorage.getItem(key));
      window.sessionStorage.removeItem(key);
    } catch {
      return;
    }
    if (!saved) return;
    const catalogIds = new Set(products.map((product) => product.id));
    const picked = [...new Set(saved.products)].filter((id) => catalogIds.has(id));
    if (picked.length === 0) return;
    const pickedSet = new Set(picked);
    const variants: Record<string, string> = {};
    for (const [productId, variantId] of Object.entries(saved.variants)) {
      if (pickedSet.has(productId)) variants[productId] = variantId;
    }
    setSelectedProducts(new Set(picked));
    setSelectedVariants(variants);
  }, [categoryId, loading, productsError, products]);

  // Query for favorites
  const { data: favoritesData = [] } = useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: fetchFavoritesAPI,
    enabled: !!session?.user,
  });

  // A starred variant is its own favorite: it does not make the whole product a favorite.
  type FavoriteRow = { product: { id: string }; variant?: { id: string } | null };
  const favoriteProducts = new Set<string>(
    (favoritesData as FavoriteRow[]).filter((fav) => !fav.variant).map((fav) => fav.product.id)
  );
  const favoriteVariants = new Set<string>(
    (favoritesData as FavoriteRow[]).flatMap((fav) => (fav.variant ? [fav.variant.id] : []))
  );

  // Mutation for adding favorite
  const addFavoriteMutation = useMutation({
    mutationFn: addFavoriteAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
    },
  });

  // Mutation for removing favorite
  const removeFavoriteMutation = useMutation({
    mutationFn: removeFavoriteAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
    },
  });

  const saveSelectionForLogin = () => {
    if (!categoryId) return;
    const variants: Record<string, string> = {};
    for (const [productId, variantId] of Object.entries(selectedVariants)) {
      if (typeof variantId === 'string') variants[productId] = variantId;
    }
    try {
      window.sessionStorage.setItem(
        selectionStorageKey(categoryId),
        JSON.stringify({ products: [...selectedProducts], variants })
      );
    } catch {
      // Storage unavailable: the guest signs in without their marks rather than crashing.
    }
  };

  const toggleProduct = (product: Product) => {
    setSelectedProducts((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(product.id)) {
        newSet.delete(product.id);
        setSelectedVariants((current) => {
          const updated = { ...current };
          delete updated[product.id];
          return updated;
        });
      } else {
        // Tapping the card picks the product itself; a variant is picked from its menu.
        newSet.add(product.id);
      }
      return newSet;
    });
  };

  // Picking the variant that is already picked takes the product off the selection; another
  // variant replaces it, since one product is added to the list once.
  const selectVariant = (product: Product, variantId: string) => {
    const alreadyPicked =
      selectedProducts.has(product.id) && selectedVariants[product.id] === variantId;
    setSelectedProducts((prev) => {
      const newSet = new Set(prev);
      if (alreadyPicked) newSet.delete(product.id);
      else newSet.add(product.id);
      return newSet;
    });
    setSelectedVariants((current) => {
      const updated = { ...current };
      if (alreadyPicked) delete updated[product.id];
      else updated[product.id] = variantId;
      return updated;
    });
  };

  const toggleFavorite = async (productId: string) => {
    if (!session?.user) {
      alert(t('signInForFavorites'));
      return;
    }

    await toggleFavoriteTarget({ productId }, favoriteProducts.has(productId));
  };

  const toggleVariantFavorite = async (variantId: string) => {
    if (!session?.user) {
      alert(t('signInForFavorites'));
      return;
    }

    await toggleFavoriteTarget({ variantId }, favoriteVariants.has(variantId));
  };

  const toggleFavoriteTarget = async (target: FavoriteTarget, isFavorite: boolean) => {
    try {
      if (isFavorite) {
        await removeFavoriteMutation.mutateAsync(target);
      } else {
        await addFavoriteMutation.mutateAsync(target);
      }
    } catch (error) {
      console.error('Error toggling favorite:', error);
    }
  };

  const addToList = async () => {
    if (addPending.current) return;
    setAddError('');
    if (!session?.user) {
      router.push('/login');
      return;
    }

    if (!activeListId) {
      setAddError(t('selectListFirst'));
      return;
    }

    addPending.current = true;
    setAdding(true);

    const selectedItems = products
      .filter((product) => selectedProducts.has(product.id))
      .map((product) => ({
        productId: product.id,
        variantId: selectedVariants[product.id] || null,
      }));

    try {
      // This endpoint commits the entire validated batch or none of it.
      await addToListAPI(activeListId, selectedItems);
    } catch (error) {
      console.error('Error adding items to list:', error);
      setAddError(t('addProductsFailed'));
      return;
    } finally {
      addPending.current = false;
      setAdding(false);
    }

    setSelectedProducts(new Set());
    setSelectedVariants({});
    refreshQueryCache(queryClient, [listsQueryKey, queryKeys.list(activeListId)]);
    router.push(`/lists/${activeListId}`);
  };

  return {
    products,
    selectedProducts,
    selectedVariants,
    favoriteProducts,
    favoriteVariants,
    loading,
    adding,
    addError,
    toggleProduct,
    selectVariant,
    toggleFavorite,
    toggleVariantFavorite,
    addToList,
    saveSelectionForLogin,
  };
}
