'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { localizedName } from '@/lib/catalog-name';
import { useLists } from '@/store/lists';
import { useProductSelection } from '@/hooks/useProductSelection';
import ProductCard from '@/components/products/ProductCard';
import ProductSelectionBar from '@/components/products/ProductSelectionBar';
import AddProductModal from '@/components/products/AddProductModal';
import { ProductCardSkeleton } from '@/components/ui/Skeleton';

function ProductsPageContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const categoryId = params.categoryId as string;
  const { data: session } = useSession();
  const { setActiveList } = useLists();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const t = useTranslations('catalog');
  const tCommon = useTranslations('common');
  const locale = useLocale();

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
    selectedVariants,
    favoriteProducts,
    favoriteVariants,
    loading,
    adding,
    toggleProduct,
    selectVariant,
    toggleFavorite,
    toggleVariantFavorite,
    addToList,
  } = useProductSelection(categoryId);

  const category = products[0]?.category;
  const categoryName = category ? localizedName(category, locale) : '';
  const isAuthenticated = Boolean(session?.user);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 pb-32">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          {category?.isCustom && category?.imageUrl ? (
            <Image
              src={category.imageUrl}
              alt={categoryName}
              width={96}
              height={96}
              className="w-24 h-24 object-contain mx-auto mb-2"
            />
          ) : (
            <div className="text-6xl mb-2">{category?.emoji || '📦'}</div>
          )}
          <h1 className="text-4xl font-bold mb-2 text-gray-900">
            {categoryName || tCommon('loading')}
          </h1>
          <p className="text-gray-700">{t('products.subtitle')}</p>

          {isAuthenticated && (
            <button
              onClick={() => setIsModalOpen(true)}
              className="mt-4 bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white px-6 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 mx-auto"
            >
              <span className="text-xl">+</span>
              <span>{t('products.addOwn')}</span>
            </button>
          )}
        </div>

        <div
          data-testid="products-grid"
          className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 md:gap-4"
        >
          {loading
            ? Array.from({ length: 12 }).map((_, i) => <ProductCardSkeleton key={i} />)
            : products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  isSelected={selectedProducts.has(product.id)}
                  selectedVariantId={selectedVariants[product.id]}
                  isFavorite={favoriteProducts.has(product.id)}
                  favoriteVariantIds={favoriteVariants}
                  showFavorite={isAuthenticated}
                  onToggle={toggleProduct}
                  onSelectVariant={selectVariant}
                  onToggleFavorite={toggleFavorite}
                  onToggleVariantFavorite={toggleVariantFavorite}
                />
              ))}
        </div>

        <div className="text-center mt-8">
          <Link href="/categories" className="text-blue-600 hover:text-blue-800 underline">
            ← {t('shared.backToCategories')}
          </Link>
        </div>
      </div>

      <ProductSelectionBar
        count={selectedProducts.size}
        adding={adding}
        isAuthenticated={isAuthenticated}
        onAddToList={addToList}
      />

      {category && (
        <AddProductModal
          categoryId={categoryId}
          categoryName={categoryName}
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onSuccess={() => {
            // Refresh products list
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}

export default function ProductsPage() {
  const t = useTranslations('common');

  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6 flex items-center justify-center">
          <div className="text-2xl">{t('loading')}</div>
        </div>
      }
    >
      <ProductsPageContent />
    </Suspense>
  );
}
