'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useProducts } from '@/hooks/admin/useProducts';
import ProductForm, { FormData } from '@/components/admin/products/ProductForm';
import ProductsTable from '@/components/admin/products/ProductsTable';
import BulkImportModal from '@/components/admin/products/BulkImportModal';
import { TableRowSkeleton } from '@/components/ui/Skeleton';

interface Category {
  id: string;
  name: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
}

interface Product {
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
  };
}

const fetchCategoriesAPI = async (): Promise<Category[]> => {
  const res = await fetch('/api/categories');
  if (!res.ok) throw new Error('Failed to fetch categories');
  return res.json();
};

export default function AdminProductsPage() {
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [scrollToProductId, setScrollToProductId] = useState<string | null>(null);
  const [showBulkImport, setShowBulkImport] = useState(false);

  const formRef = useRef<HTMLDivElement>(null);
  const { products, loading, createProduct, updateProduct, deleteProduct, fetchProducts } =
    useProducts();

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: fetchCategoriesAPI,
  });

  // Auto-scroll to product after save
  useEffect(() => {
    if (scrollToProductId) {
      const element = document.getElementById(`product-${scrollToProductId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('ring-4', 'ring-blue-500');
        setTimeout(() => {
          element.classList.remove('ring-4', 'ring-blue-500');
        }, 2000);
      }
      setScrollToProductId(null);
    }
  }, [scrollToProductId, products]);

  const handleSubmit = async (formData: FormData, imageUrl?: string) => {
    const savedProductId = editingProduct?.id;

    try {
      let savedProduct;

      if (editingProduct) {
        savedProduct = await updateProduct(editingProduct.id, formData, imageUrl);
      } else {
        savedProduct = await createProduct(formData, imageUrl);
      }

      resetForm();

      if (savedProductId || savedProduct.id) {
        setScrollToProductId(savedProductId || savedProduct.id);
      }
    } catch (error) {
      console.error('Error saving product:', error);
      alert('Ошибка при сохранении продукта');
    }
  };

  const handleEdit = (product: Product) => {
    setEditingProduct(product);
    setShowForm(true);

    setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProduct(id);
    } catch (error) {
      console.error('Error deleting product:', error);
      alert('Ошибка при удалении продукта');
    }
  };

  const resetForm = () => {
    setEditingProduct(null);
    setShowForm(false);
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
          <div className="flex flex-col gap-4">
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">Продукты</h1>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => setShowBulkImport(true)}
                className="flex-1 sm:flex-none bg-purple-600 hover:bg-purple-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors whitespace-nowrap"
              >
                📦 Массовый импорт
              </button>
              <button
                onClick={() => setShowForm(!showForm)}
                className="flex-1 sm:flex-none bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors whitespace-nowrap"
              >
                {showForm ? 'Отмена' : '+ Добавить'}
              </button>
            </div>
          </div>
        </div>

        {showForm && (
          <div ref={formRef} className="bg-white p-6 rounded-xl shadow-md mb-8">
            <h2 className="text-2xl font-bold mb-4">
              {editingProduct ? 'Редактировать продукт' : 'Новый продукт'}
            </h2>
            <ProductForm
              product={editingProduct}
              categories={categories}
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
                    Иконка
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Название
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Категория
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {Array.from({ length: 8 }).map((_, i) => (
                  <TableRowSkeleton key={i} columns={4} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ProductsTable products={products} onEdit={handleEdit} onDelete={handleDelete} />
        )}

        {showBulkImport && (
          <BulkImportModal
            onClose={() => setShowBulkImport(false)}
            onImportComplete={fetchProducts}
          />
        )}
      </div>
    </div>
  );
}
