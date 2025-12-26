'use client';

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

interface CategoriesTableProps {
  categories: Category[];
  onEdit: (category: Category) => void;
  onDelete: (id: string) => void;
  onManageProducts: (category: Category) => void;
}

export default function CategoriesTable({
  categories,
  onEdit,
  onDelete,
  onManageProducts,
}: CategoriesTableProps) {
  return (
    <>
      {/* Desktop Table View */}
      <div className="bg-white rounded-xl shadow-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Порядок
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Иконка
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Название
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Продуктов
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Действия
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {categories.map((category) => (
                <tr
                  key={category.id}
                  id={`category-${category.id}`}
                  className="hover:bg-gray-50 transition-all"
                >
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {category.order}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-2xl">
                    {category.isCustom && category.imageUrl ? (
                      <img
                        src={category.imageUrl}
                        alt={category.name}
                        className="w-12 h-12 object-contain"
                      />
                    ) : (
                      category.emoji
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{category.name}</div>
                    <div className="text-sm text-gray-500">{category.nameEn}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {category._count?.products || 0}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-4">
                    <button
                      onClick={() => onManageProducts(category)}
                      className="text-purple-600 hover:text-purple-900"
                    >
                      Товары
                    </button>
                    <button
                      onClick={() => onEdit(category)}
                      className="text-blue-600 hover:text-blue-900"
                    >
                      Редактировать
                    </button>
                    <button
                      onClick={() => onDelete(category.id)}
                      className="text-red-600 hover:text-red-900"
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden space-y-4">
        {categories.map((category) => (
          <div
            key={category.id}
            id={`category-${category.id}`}
            className="bg-white rounded-xl shadow-md p-4 transition-all"
          >
            <div className="flex items-start gap-4 mb-4">
              <div className="text-4xl flex-shrink-0">
                {category.isCustom && category.imageUrl ? (
                  <img
                    src={category.imageUrl}
                    alt={category.name}
                    className="w-12 h-12 object-contain"
                  />
                ) : (
                  category.emoji
                )}
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900">{category.name}</h3>
                <p className="text-sm text-gray-500">{category.nameEn}</p>
                <div className="mt-2 flex items-center gap-4 text-xs text-gray-600">
                  <span>Порядок: {category.order}</span>
                  <span>Товаров: {category._count?.products || 0}</span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-3 border-t border-gray-100">
              <button
                onClick={() => onManageProducts(category)}
                className="bg-purple-50 text-purple-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-purple-100 transition-colors"
              >
                Товары
              </button>
              <button
                onClick={() => onEdit(category)}
                className="bg-blue-50 text-blue-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors"
              >
                Изменить
              </button>
              <button
                onClick={() => onDelete(category.id)}
                className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors"
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
