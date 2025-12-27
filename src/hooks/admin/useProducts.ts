import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface Product {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  categoryId: string;
  category: {
    id: string;
    name: string;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
  };
}

interface ProductInput {
  name: string;
  nameEn: string;
  emoji: string;
  categoryId: string;
  isCustom: boolean;
  imageUrl: string;
}

// API functions
const fetchProductsAPI = async (): Promise<Product[]> => {
  const res = await fetch('/api/products');
  if (!res.ok) throw new Error('Failed to fetch products');
  return res.json();
};

const createProductAPI = async (data: ProductInput, imageUrl?: string) => {
  const res = await fetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...data,
      isCustom: data.isCustom || !!imageUrl,
      imageUrl: imageUrl || null,
    }),
  });
  if (!res.ok) throw new Error('Failed to create product');
  return res.json();
};

const updateProductAPI = async (id: string, data: ProductInput, imageUrl?: string) => {
  const res = await fetch(`/api/products/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...data,
      isCustom: data.isCustom || !!imageUrl,
      imageUrl: imageUrl || null,
    }),
  });
  if (!res.ok) throw new Error('Failed to update product');
  return res.json();
};

const deleteProductAPI = async (id: string) => {
  const res = await fetch(`/api/products/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete product');
  return res.json();
};

// React Query Hook
export function useProducts() {
  const queryClient = useQueryClient();

  // Query for fetching products
  const {
    data: products = [],
    isLoading: loading,
    refetch: fetchProducts,
  } = useQuery({
    queryKey: ['products'],
    queryFn: fetchProductsAPI,
  });

  // Mutation for creating product
  const createMutation = useMutation({
    mutationFn: ({ data, imageUrl }: { data: ProductInput; imageUrl?: string }) =>
      createProductAPI(data, imageUrl),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  // Mutation for updating product
  const updateMutation = useMutation({
    mutationFn: ({ id, data, imageUrl }: { id: string; data: ProductInput; imageUrl?: string }) =>
      updateProductAPI(id, data, imageUrl),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  // Mutation for deleting product
  const deleteMutation = useMutation({
    mutationFn: deleteProductAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  // Wrapper functions to maintain API compatibility
  const createProduct = async (productData: ProductInput, imageUrl?: string) => {
    return createMutation.mutateAsync({ data: productData, imageUrl });
  };

  const updateProduct = async (id: string, productData: ProductInput, imageUrl?: string) => {
    return updateMutation.mutateAsync({ id, data: productData, imageUrl });
  };

  const deleteProduct = async (id: string) => {
    if (!confirm('Вы уверены?')) {
      return false;
    }
    await deleteMutation.mutateAsync(id);
    return true;
  };

  return {
    products,
    loading,
    fetchProducts,
    createProduct,
    updateProduct,
    deleteProduct,
  };
}
