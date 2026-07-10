'use client';

import Image from 'next/image';
import { useState } from 'react';

interface Product {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  categoryId: string;
  variants?: { id: string; name: string; nameEn: string; emoji: string }[];
  category: {
    id: string;
    name: string;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
  };
}

interface ProductsTableProps {
  products: Product[];
  onEdit: (product: Product) => void;
  onDelete: (id: string) => void;
}

export default function ProductsTable({ products, onEdit, onDelete }: ProductsTableProps) {
  const [sortField, setSortField] = useState<'name' | 'category' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const handleSort = (field: 'name' | 'category') => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedProducts = [...products].sort((a, b) => {
    if (!sortField) return 0;

    let comparison = 0;
    if (sortField === 'name') {
      comparison = a.name.localeCompare(b.name, 'ru');
    } else if (sortField === 'category') {
      comparison = a.category.name.localeCompare(b.category.name, 'ru');
    }

    return sortDirection === 'asc' ? comparison : -comparison;
  });

  return (
    <>
      {/* Desktop Table View */}
      <div className="hidden md:block bg-white rounded-xl shadow-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full table-auto">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  Изображение
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('name')}
                >
                  <div className="flex items-center gap-1">
                    Название
                    {sortField === 'name' && (
                      <span className="text-blue-600">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('category')}
                >
                  <div className="flex items-center gap-1">
                    Категория
                    {sortField === 'category' && (
                      <span className="text-blue-600">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  Действия
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sortedProducts.map((product) => (
                <tr
                  key={product.id}
                  id={`product-${product.id}`}
                  className="hover:bg-gray-50 transition-all"
                >
                  <td className="px-4 py-4 align-top whitespace-nowrap">
                    {product.isCustom && product.imageUrl ? (
                      <Image
                        src={product.imageUrl}
                        alt={product.name}
                        width={48}
                        height={48}
                        className="w-12 h-12 object-contain"
                        unoptimized
                      />
                    ) : (
                      <span className="text-3xl">{product.emoji}</span>
                    )}
                  </td>
                  <td className="px-4 py-4 align-top min-w-45">
                    <div className="text-sm font-medium text-gray-900 wrap-break-word">
                      {product.name}
                    </div>
                    <div className="text-sm text-gray-500 wrap-break-word">{product.nameEn}</div>
                  </td>
                  <td className="px-4 py-4 align-top text-sm text-gray-500 min-w-45">
                    <div className="flex items-center gap-2">
                      {product.category.isCustom && product.category.imageUrl ? (
                        <Image
                          src={product.category.imageUrl}
                          alt={product.category.name}
                          width={24}
                          height={24}
                          className="w-6 h-6 object-contain"
                          unoptimized
                        />
                      ) : (
                        <span>{product.category.emoji}</span>
                      )}
                      <span className="wrap-break-word">{product.category.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-right text-sm font-medium align-top whitespace-nowrap">
                    <div className="flex items-center justify-end gap-4">
                      <button
                        onClick={() => onEdit(product)}
                        className="text-blue-600 hover:text-blue-900"
                      >
                        Редактировать
                      </button>
                      <button
                        onClick={() => onDelete(product.id)}
                        className="text-red-600 hover:text-red-900"
                      >
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden space-y-4">
        {sortedProducts.map((product) => (
          <div
            key={product.id}
            id={`product-${product.id}`}
            className="bg-white rounded-xl shadow-md p-4 transition-all"
          >
            <div className="flex items-start gap-4 mb-3">
              <div className="shrink-0">
                {product.isCustom && product.imageUrl ? (
                  <Image
                    src={product.imageUrl}
                    alt={product.name}
                    width={64}
                    height={64}
                    className="w-16 h-16 object-contain"
                    unoptimized
                  />
                ) : (
                  <span className="text-5xl">{product.emoji}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="mb-1">
                  <h3 className="font-semibold text-gray-900 wrap-break-word">{product.name}</h3>
                  <p className="text-sm text-gray-500 wrap-break-word">{product.nameEn}</p>
                </div>
                <div className="flex items-center gap-2 mt-1 text-sm text-gray-600">
                  {product.category.isCustom && product.category.imageUrl ? (
                    <Image
                      src={product.category.imageUrl}
                      alt={product.category.name}
                      width={20}
                      height={20}
                      className="w-5 h-5 object-contain"
                      unoptimized
                    />
                  ) : (
                    <span>{product.category.emoji}</span>
                  )}
                  <span>{product.category.name}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-3 border-t border-gray-100">
              <button
                onClick={() => onEdit(product)}
                className="flex-1 bg-blue-50 text-blue-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors"
              >
                Редактировать
              </button>
              <button
                onClick={() => onDelete(product.id)}
                className="flex-1 bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors"
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
