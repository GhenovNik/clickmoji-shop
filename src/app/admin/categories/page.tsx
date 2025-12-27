'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCategories } from '@/hooks/admin/useCategories';
import CategoryForm, { FormData } from '@/components/admin/categories/CategoryForm';
import CategoriesTable from '@/components/admin/categories/CategoriesTable';
import ProductMoveModal from '@/components/admin/categories/ProductMoveModal';
import { TableRowSkeleton } from '@/components/ui/Skeleton';

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

interface Product {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  categoryId: string;
}

const fetchProductsByCategoryAPI = async (categoryId: string): Promise<Product[]> => {
  const res = await fetch(`/api/products?categoryId=${categoryId}`);
  if (!res.ok) throw new Error('Failed to fetch products');
  return res.json();
};

export default function AdminCategoriesPage() {
  const [showForm, setShowForm] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [scrollToCategoryId, setScrollToCategoryId] = useState<string | null>(null);
  const [showProductsModal, setShowProductsModal] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);

  const formRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const {
    categories,
    loading,
    createCategory,
    updateCategory,
    deleteCategory,
    getNextOrder,
    fetchCategories,
  } = useCategories();

  const { data: categoryProducts = [] } = useQuery({
    queryKey: ['products', selectedCategory?.id],
    queryFn: () => fetchProductsByCategoryAPI(selectedCategory!.id),
    enabled: !!selectedCategory?.id,
  });

  // Auto-scroll to category after save
  useEffect(() => {
    if (scrollToCategoryId) {
      const element = document.getElementById(`category-${scrollToCategoryId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('ring-4', 'ring-blue-500');
        setTimeout(() => {
          element.classList.remove('ring-4', 'ring-blue-500');
        }, 2000);
      }
      setScrollToCategoryId(null);
    }
  }, [scrollToCategoryId, categories]);

  const handleSubmit = async (formData: FormData, imageUrl?: string) => {
    const savedCategoryId = editingCategory?.id;

    try {
      let savedCategory;

      if (editingCategory) {
        savedCategory = await updateCategory(editingCategory.id, formData, imageUrl);
      } else {
        savedCategory = await createCategory(formData, imageUrl);
      }

      resetForm();

      if (savedCategoryId || savedCategory.id) {
        setScrollToCategoryId(savedCategoryId || savedCategory.id);
      }
    } catch (error) {
      console.error('Error saving category:', error);
      alert('Ошибка при сохранении категории');
    }
  };

  const handleEdit = (category: Category) => {
    setEditingCategory(category);
    setShowForm(true);

    setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCategory(id);
    } catch (error) {
      console.error('Error deleting category:', error);
      alert('Ошибка при удалении категории');
    }
  };

  const resetForm = () => {
    setEditingCategory(null);
    setShowForm(false);
  };

  const handleManageProducts = (category: Category) => {
    setSelectedCategory(category);
    setShowProductsModal(true);
  };

  const handleProductsMoved = () => {
    queryClient.invalidateQueries({ queryKey: ['categories'] });
    if (selectedCategory) {
      queryClient.invalidateQueries({ queryKey: ['products', selectedCategory.id] });
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <Link
            href="/admin"
            className="text-blue-600 hover:text-blue-700 text-sm mb-4 inline-block"
          >
            ← Назад в админ-панель
          </Link>
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Категории</h1>
            <button
              onClick={() => {
                if (!showForm) {
                  // Nothing needed - form will get nextOrder from hook
                }
                setShowForm(!showForm);
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors whitespace-nowrap"
            >
              {showForm ? 'Отмена' : '+ Добавить'}
            </button>
          </div>
        </div>

        {showForm && (
          <div ref={formRef} className="bg-white p-6 rounded-xl shadow-md mb-8">
            <h2 className="text-2xl font-bold mb-4">
              {editingCategory ? 'Редактировать категорию' : 'Новая категория'}
            </h2>
            <CategoryForm
              category={editingCategory}
              nextOrder={getNextOrder()}
              onSubmit={handleSubmit}
              onCancel={resetForm}
            />
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-xl shadow-md overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Порядок
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Иконка
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Название
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Продуктов
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {Array.from({ length: 5 }).map((_, i) => (
                  <TableRowSkeleton key={i} columns={5} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <CategoriesTable
            categories={categories}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onManageProducts={handleManageProducts}
          />
        )}

        {showProductsModal && selectedCategory && (
          <ProductMoveModal
            category={selectedCategory}
            products={categoryProducts}
            allCategories={categories}
            onClose={() => setShowProductsModal(false)}
            onMoveComplete={handleProductsMoved}
          />
        )}
      </div>
    </div>
  );
}
