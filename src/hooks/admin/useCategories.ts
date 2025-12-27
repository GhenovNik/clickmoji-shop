import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface Category {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  order: number;
  _count?: {
    products: number;
  };
}

interface CategoryInput {
  name: string;
  nameEn: string;
  emoji: string;
  order: number;
  isCustom: boolean;
  imageUrl: string;
}

// API functions
const fetchCategoriesAPI = async (): Promise<Category[]> => {
  const res = await fetch('/api/categories');
  if (!res.ok) throw new Error('Failed to fetch categories');
  return res.json();
};

const createCategoryAPI = async (data: CategoryInput, imageUrl?: string) => {
  const res = await fetch('/api/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...data,
      emoji: data.emoji || '📦',
      imageUrl: imageUrl,
      isCustom: !!imageUrl,
    }),
  });
  if (!res.ok) throw new Error('Failed to create category');
  return res.json();
};

const updateCategoryAPI = async (id: string, data: CategoryInput, imageUrl?: string) => {
  const res = await fetch(`/api/categories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...data,
      emoji: data.emoji || '📦',
      imageUrl: imageUrl,
      isCustom: !!imageUrl,
    }),
  });
  if (!res.ok) throw new Error('Failed to update category');
  return res.json();
};

const deleteCategoryAPI = async (id: string) => {
  const res = await fetch(`/api/categories/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete category');
  return res.json();
};

// React Query Hook
export function useCategories() {
  const queryClient = useQueryClient();

  // Query for fetching categories
  const {
    data: categories = [],
    isLoading: loading,
    refetch: fetchCategories,
  } = useQuery({
    queryKey: ['categories'],
    queryFn: fetchCategoriesAPI,
  });

  // Mutation for creating category
  const createMutation = useMutation({
    mutationFn: ({ data, imageUrl }: { data: CategoryInput; imageUrl?: string }) =>
      createCategoryAPI(data, imageUrl),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  // Mutation for updating category
  const updateMutation = useMutation({
    mutationFn: ({ id, data, imageUrl }: { id: string; data: CategoryInput; imageUrl?: string }) =>
      updateCategoryAPI(id, data, imageUrl),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  // Mutation for deleting category
  const deleteMutation = useMutation({
    mutationFn: deleteCategoryAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  // Helper function to get next order
  const getNextOrder = () => {
    return categories.length > 0 ? Math.max(...categories.map((c) => c.order)) + 1 : 1;
  };

  // Wrapper functions to maintain API compatibility
  const createCategory = async (categoryData: CategoryInput, imageUrl?: string) => {
    return createMutation.mutateAsync({ data: categoryData, imageUrl });
  };

  const updateCategory = async (id: string, categoryData: CategoryInput, imageUrl?: string) => {
    return updateMutation.mutateAsync({ id, data: categoryData, imageUrl });
  };

  const deleteCategory = async (id: string) => {
    if (!confirm('Удалить категорию? Все продукты в ней также будут удалены.')) {
      return false;
    }
    await deleteMutation.mutateAsync(id);
    return true;
  };

  return {
    categories,
    loading,
    fetchCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    getNextOrder,
  };
}
