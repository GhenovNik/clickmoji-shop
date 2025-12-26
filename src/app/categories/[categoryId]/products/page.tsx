'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useProductSelection } from '@/hooks/useProductSelection';
import ProductCard from '@/components/products/ProductCard';
import ProductSelectionBar from '@/components/products/ProductSelectionBar';

export default function ProductsPage() {
  const params = useParams();
  const categoryId = params.categoryId as string;
  const { data: session } = useSession();

  const {
    products,
    selectedProducts,
    favoriteProducts,
    loading,
    adding,
    toggleProduct,
    toggleFavorite,
    addToList,
  } = useProductSelection(categoryId);

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
        <div className="text-center mb-8">
          <div className="text-6xl mb-2">{category?.emoji}</div>
          <h1 className="text-4xl font-bold mb-2 text-gray-900">{category?.name}</h1>
          <p className="text-gray-700">Выберите товары одним нажатием</p>
        </div>

        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              isSelected={selectedProducts.has(product.id)}
              isFavorite={favoriteProducts.has(product.id)}
              showFavorite={!!session?.user}
              onToggle={toggleProduct}
              onToggleFavorite={toggleFavorite}
            />
          ))}
        </div>

        <div className="text-center mt-8">
          <Link href="/categories" className="text-blue-600 hover:text-blue-800 underline">
            ← Назад к категориям
          </Link>
        </div>
      </div>

      <ProductSelectionBar count={selectedProducts.size} adding={adding} onAddToList={addToList} />
    </div>
  );
}
