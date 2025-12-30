'use client';

import { Suspense, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useLists } from '@/store/lists';
import { useProductSelection } from '@/hooks/useProductSelection';
import ProductCard from '@/components/products/ProductCard';
import ProductSelectionBar from '@/components/products/ProductSelectionBar';
import { ProductCardSkeleton } from '@/components/ui/Skeleton';

function ProductsPageContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const categoryId = params.categoryId as string;
  const { data: session } = useSession();
  const { setActiveList } = useLists();

  // Set active list from URL parameter
  useEffect(() => {
    const listIdFromUrl = searchParams.get('listId');
    if (listIdFromUrl) {
      setActiveList(listIdFromUrl);
    }
  }, [searchParams, setActiveList]);

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

  const category = products[0]?.category;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 pb-32">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          {category?.isCustom && category?.imageUrl ? (
            <img
              src={category.imageUrl}
              alt={category.name}
              className="w-24 h-24 object-contain mx-auto mb-2"
            />
          ) : (
            <div className="text-6xl mb-2">{category?.emoji || '📦'}</div>
          )}
          <h1 className="text-4xl font-bold mb-2 text-gray-900">
            {category?.name || 'Загрузка...'}
          </h1>
          <p className="text-gray-700">Выберите товары одним нажатием</p>
        </div>

        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {loading
            ? Array.from({ length: 12 }).map((_, i) => <ProductCardSkeleton key={i} />)
            : products.map((product) => (
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

export default function ProductsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 flex items-center justify-center">
          <div className="text-2xl">Загрузка...</div>
        </div>
      }
    >
      <ProductsPageContent />
    </Suspense>
  );
}
