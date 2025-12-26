import { useState, useEffect } from 'react';

interface Category {
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

export function useCategories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCategories = async () => {
    try {
      const res = await fetch('/api/categories');
      const data = await res.json();
      setCategories(data);
    } catch (error) {
      console.error('Error fetching categories:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCategories();
  }, []);

  const createCategory = async (
    categoryData: {
      name: string;
      nameEn: string;
      emoji: string;
      order: number;
      isCustom: boolean;
      imageUrl: string;
    },
    imageUrl?: string
  ) => {
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...categoryData,
        emoji: categoryData.emoji || '📦',
        imageUrl: imageUrl,
        isCustom: !!imageUrl,
      }),
    });

    if (!res.ok) {
      throw new Error('Failed to create category');
    }

    const savedCategory = await res.json();
    await fetchCategories();
    return savedCategory;
  };

  const updateCategory = async (
    id: string,
    categoryData: {
      name: string;
      nameEn: string;
      emoji: string;
      order: number;
      isCustom: boolean;
      imageUrl: string;
    },
    imageUrl?: string
  ) => {
    const res = await fetch(`/api/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...categoryData,
        emoji: categoryData.emoji || '📦',
        imageUrl: imageUrl,
        isCustom: !!imageUrl,
      }),
    });

    if (!res.ok) {
      throw new Error('Failed to update category');
    }

    const savedCategory = await res.json();
    await fetchCategories();
    return savedCategory;
  };

  const deleteCategory = async (id: string) => {
    if (!confirm('Вы уверены? Это удалит все продукты в категории!')) {
      return false;
    }

    const res = await fetch(`/api/categories/${id}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      throw new Error('Failed to delete category');
    }

    await fetchCategories();
    return true;
  };

  const getNextOrder = () => {
    return categories.length > 0 ? Math.max(...categories.map((c) => c.order)) + 1 : 1;
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
