'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

type Product = {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  category: {
    id: string;
    name: string;
    emoji: string;
  };
};

export default function ProductsPage() {
  const params = useParams();
  const router = useRouter();
  const categoryId = params.categoryId as string;

  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/products?categoryId=${categoryId}`)
      .then((res) => res.json())
      .then((data) => {
        setProducts(data);
        setLoading(false);
      })
      .catch((error) => {
        console.error('Error loading products:', error);
        setLoading(false);
      });
  }, [categoryId]);

  const toggleProduct = (productId: string) => {
    setSelectedProducts((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(productId)) {
        newSet.delete(productId);
      } else {
        newSet.add(productId);
      }
      return newSet;
    });
  };

  const handleAddToList = () => {
    // TODO: Implement add to shopping list
    alert(`Добавлено ${selectedProducts.size} товаров в список!`);
    router.push('/categories');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  const category = products[0]?.category;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 pb-32">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-2">{category?.emoji}</div>
          <h1 className="text-4xl font-bold mb-2 text-gray-900">{category?.name}</h1>
          <p className="text-gray-700">Выберите товары одним нажатием</p>
        </div>

        {/* Products Grid */}
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {products.map((product) => {
            const isSelected = selectedProducts.has(product.id);
            return (
              <button
                key={product.id}
                onClick={() => toggleProduct(product.id)}
                className={`
                  bg-white rounded-2xl p-4 shadow-md transition-all
                  ${isSelected
                    ? 'ring-4 ring-green-500 scale-95'
                    : 'hover:shadow-lg hover:scale-105'
                  }
                `}
              >
                <div className="text-center">
                  <div className="text-4xl mb-2">{product.emoji}</div>
                  <p className="text-sm font-medium text-gray-900">{product.name}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Back Link */}
        <div className="text-center mt-8">
          <Link
            href="/categories"
            className="text-blue-600 hover:text-blue-800 underline"
          >
            ← Назад к категориям
          </Link>
        </div>
      </div>

      {/* Fixed Bottom Button */}
      {selectedProducts.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="text-lg font-semibold">
              Выбрано: {selectedProducts.size}
            </div>
            <button
              onClick={handleAddToList}
              className="bg-green-500 hover:bg-green-600 text-white px-8 py-3 rounded-xl font-semibold transition-colors"
            >
              Добавить в список
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
