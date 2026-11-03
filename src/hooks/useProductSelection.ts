'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { listsQueryKey, useActiveList } from './useListsQuery';
import { queryKeys } from '@/lib/query-keys';

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

  // Query for products by category
  const { data: products = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.categoryProducts(categoryId),
    queryFn: () => fetchProductsByCategoryAPI(categoryId),
    enabled: !!categoryId,
  });

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
    setAddError('');
    if (!session?.user) {
      router.push('/login');
      return;
    }

    if (!activeListId) {
      setAddError(t('selectListFirst'));
      return;
    }

    setAdding(true);

    const selectedItems = products
      .filter((product) => selectedProducts.has(product.id))
      .map((product) => ({
        productId: product.id,
        variantId: selectedVariants[product.id] || null,
      }));

    try {
      await addToListAPI(activeListId, selectedItems);

      queryClient.invalidateQueries({ queryKey: listsQueryKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.list(activeListId) });

      if (activeListId) {
        router.push(`/lists/${activeListId}`);
      } else {
        router.push('/lists');
      }
    } catch (error) {
      console.error('Error adding items to list:', error);
      setAddError(t('addProductsFailed'));
    } finally {
      setAdding(false);
    }
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
  };
}
