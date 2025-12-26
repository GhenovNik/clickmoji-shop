'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useCategories } from '@/hooks/admin/useCategories';
import CategoryForm, { FormData } from '@/components/admin/categories/CategoryForm';
import CategoriesTable from '@/components/admin/categories/CategoriesTable';
import ProductMoveModal from '@/components/admin/categories/ProductMoveModal';

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

export default function AdminCategoriesPage() {
  const [showForm, setShowForm] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [scrollToCategoryId, setScrollToCategoryId] = useState<string | null>(null);
  const [showProductsModal, setShowProductsModal] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [categoryProducts, setCategoryProducts] = useState<Product[]>([]);

  const formRef = useRef<HTMLDivElement>(null);
  const {
    categories,
    loading,
    createCategory,
    updateCategory,
    deleteCategory,
    getNextOrder,
    fetchCategories,
  } = useCategories();

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

  const handleManageProducts = async (category: Category) => {
    setSelectedCategory(category);
    try {
      const res = await fetch(`/api/products?categoryId=${category.id}`);
      const data = await res.json();
      setCategoryProducts(data);
      setShowProductsModal(true);
    } catch (error) {
      console.error('Error fetching products:', error);
      alert('Ошибка при загрузке продуктов');
    }
  };

  const handleProductsMoved = async () => {
    await fetchCategories();
    if (selectedCategory) {
      const res = await fetch(`/api/products?categoryId=${selectedCategory.id}`);
      const data = await res.json();
      setCategoryProducts(data);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-lg text-gray-600">Загрузка...</div>
      </div>
    );
  }

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

        <CategoriesTable
          categories={categories}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onManageProducts={handleManageProducts}
        />

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
