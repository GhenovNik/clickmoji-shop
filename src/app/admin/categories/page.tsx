'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useUploadThing } from '@/lib/uploadthing';

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
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [emojiResults, setEmojiResults] = useState<Array<{ emoji: string; label: string; shortcodes?: string[] }>>([]);
  const [searchingEmoji, setSearchingEmoji] = useState(false);
  const [generatingAI, setGeneratingAI] = useState(false);
  const [showProductsModal, setShowProductsModal] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [categoryProducts, setCategoryProducts] = useState<Product[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [targetCategoryId, setTargetCategoryId] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const { startUpload } = useUploadThing("productImage");

  const [formData, setFormData] = useState({
    name: '',
    nameEn: '',
    emoji: '',
    order: 0,
    isCustom: false,
    imageUrl: '',
  });

  useEffect(() => {
    fetchCategories();
  }, []);

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

  const searchEmoji = async () => {
    if (!formData.name) {
      alert('Введите название категории для поиска emoji');
      return;
    }

    setSearchingEmoji(true);
    try {
      const res = await fetch(`/api/emoji/search?q=${encodeURIComponent(formData.name)}`);
      const data = await res.json();
      setEmojiResults(data.results || []);
    } catch (error) {
      console.error('Error searching emoji:', error);
      alert('Ошибка при поиске emoji');
    } finally {
      setSearchingEmoji(false);
    }
  };

  const generateAIEmoji = async () => {
    if (!formData.name) {
      alert('Введите название категории для генерации иконки');
      return;
    }

    setGeneratingAI(true);
    try {
      const res = await fetch('/api/emoji/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productName: formData.name }),
      });

      const data = await res.json();

      if (res.ok && data.imageUrl) {
        // Автоматически устанавливаем сгенерированное изображение
        setFormData({
          ...formData,
          imageUrl: data.imageUrl,
          isCustom: true,
        });
        alert('✅ AI иконка успешно сгенерирована!');
      } else {
        alert(data.error || 'Ошибка при генерации иконки');
      }
    } catch (error) {
      console.error('Error generating AI emoji:', error);
      alert('Ошибка при генерации иконки');
    } finally {
      setGeneratingAI(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      let uploadedImageUrl = formData.imageUrl;

      // Загружаем файл если выбран
      if (selectedFile) {
        setUploading(true);
        try {
          const uploadedFiles = await startUpload([selectedFile]);
          if (uploadedFiles && uploadedFiles[0]) {
            uploadedImageUrl = uploadedFiles[0].ufsUrl;
          }
        } catch (uploadError) {
          console.error('Upload error:', uploadError);
          alert('Ошибка при загрузке файла');
          setUploading(false);
          return;
        } finally {
          setUploading(false);
        }
      }

      const url = editingCategory
        ? `/api/categories/${editingCategory.id}`
        : '/api/categories';
      const method = editingCategory ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          emoji: formData.emoji || '📦', // Дефолтное значение если пустое
          imageUrl: uploadedImageUrl,
          isCustom: !!uploadedImageUrl,
        }),
      });

      if (res.ok) {
        await fetchCategories();
        resetForm();
      } else {
        alert('Ошибка при сохранении категории');
      }
    } catch (error) {
      console.error('Error saving category:', error);
      alert('Ошибка при сохранении категории');
    }
  };

  const handleEdit = (category: Category) => {
    setEditingCategory(category);
    setFormData({
      name: category.name,
      nameEn: category.nameEn,
      emoji: category.emoji,
      order: category.order,
      isCustom: category.isCustom,
      imageUrl: category.imageUrl || '',
    });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Вы уверены? Это удалит все продукты в категории!')) {
      return;
    }

    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        await fetchCategories();
      } else {
        alert('Ошибка при удалении категории');
      }
    } catch (error) {
      console.error('Error deleting category:', error);
      alert('Ошибка при удалении категории');
    }
  };

  const resetForm = () => {
    // Автоматически определяем следующий order
    const nextOrder = categories.length > 0
      ? Math.max(...categories.map(c => c.order)) + 1
      : 1;

    setFormData({ name: '', nameEn: '', emoji: '', order: nextOrder, isCustom: false, imageUrl: '' });
    setEditingCategory(null);
    setSelectedFile(null);
    setShowForm(false);
    setEmojiResults([]);
  };

  const handleManageProducts = async (category: Category) => {
    setSelectedCategory(category);
    setShowProductsModal(true);

    try {
      const res = await fetch(`/api/products?categoryId=${category.id}`);
      const data = await res.json();
      setCategoryProducts(data);
    } catch (error) {
      console.error('Error fetching products:', error);
      alert('Ошибка при загрузке продуктов');
    }
  };

  const toggleProductSelection = (productId: string) => {
    setSelectedProductIds(prev =>
      prev.includes(productId)
        ? prev.filter(id => id !== productId)
        : [...prev, productId]
    );
  };

  const handleMoveProducts = async () => {
    if (selectedProductIds.length === 0) {
      alert('Выберите хотя бы один продукт');
      return;
    }

    if (!targetCategoryId) {
      alert('Выберите целевую категорию');
      return;
    }

    try {
      const res = await fetch('/api/products/move-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds: selectedProductIds,
          newCategoryId: targetCategoryId,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        alert(`✅ Перемещено продуктов: ${data.movedCount} → ${data.targetCategory}`);
        setShowProductsModal(false);
        setSelectedProductIds([]);
        setTargetCategoryId('');
        await fetchCategories();
      } else {
        alert(data.error || 'Ошибка при перемещении продуктов');
      }
    } catch (error) {
      console.error('Error moving products:', error);
      alert('Ошибка при перемещении продуктов');
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
          <div className="flex justify-between items-center">
            <h1 className="text-4xl font-bold text-gray-900">Категории</h1>
            <button
              onClick={() => {
                if (!showForm) {
                  // Автоматически устанавливаем следующий order при открытии формы
                  const nextOrder = categories.length > 0
                    ? Math.max(...categories.map(c => c.order)) + 1
                    : 1;
                  setFormData({ ...formData, order: nextOrder });
                }
                setShowForm(!showForm);
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors"
            >
              {showForm ? 'Отмена' : '+ Добавить категорию'}
            </button>
          </div>
        </div>

        {showForm && (
          <div className="bg-white p-6 rounded-xl shadow-md mb-8">
            <h2 className="text-2xl font-bold mb-4">
              {editingCategory ? 'Редактировать категорию' : 'Новая категория'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Название (RU)
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Название (EN)
                  </label>
                  <input
                    type="text"
                    value={formData.nameEn}
                    onChange={(e) => setFormData({ ...formData, nameEn: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Emoji
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={formData.emoji}
                      onChange={(e) => setFormData({ ...formData, emoji: e.target.value })}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-2xl text-gray-900"
                      placeholder="🍎"
                      required={!selectedFile && !formData.imageUrl}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={searchEmoji}
                        disabled={searchingEmoji || !formData.name}
                        className="flex-1 sm:flex-none px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        {searchingEmoji ? 'Поиск...' : '🔍 Подобрать'}
                      </button>
                      <button
                        type="button"
                        onClick={generateAIEmoji}
                        disabled={generatingAI || !formData.name}
                        className="flex-1 sm:flex-none px-4 py-2 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                        title="Сгенерировать иконку с помощью AI (для справки)"
                      >
                        {generatingAI ? '⏳' : '🎨'}
                      </button>
                    </div>
                  </div>
                  {emojiResults.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
                      {emojiResults.map((result, index) => (
                        <button
                          key={index}
                          type="button"
                          onClick={() => {
                            setFormData({ ...formData, emoji: result.emoji });
                            setEmojiResults([]);
                          }}
                          className="px-3 py-2 bg-white hover:bg-blue-50 border border-gray-200 rounded-lg text-left hover:border-blue-500 transition-colors flex items-center gap-3"
                          title={result.label}
                        >
                          <span className="text-2xl leading-none">{result.emoji}</span>
                          <span className="text-sm text-gray-700">
                            {result.label}
                            {result.shortcodes?.length ? (
                              <span className="ml-1 text-gray-400">/{result.shortcodes[0]}</span>
                            ) : null}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {formData.isCustom && formData.imageUrl && (
                    <div className="mt-2 p-3 bg-gradient-to-br from-purple-50 to-pink-50 rounded-lg border border-purple-200">
                      <div className="flex items-center gap-3">
                        <img
                          src={formData.imageUrl}
                          alt="AI Generated Icon"
                          className="w-16 h-16 object-contain bg-white rounded-lg p-2 shadow-sm"
                        />
                        <div className="flex-1">
                          <p className="text-sm font-medium text-purple-900">AI-сгенерированная иконка</p>
                          <p className="text-xs text-purple-600 mt-1">Будет использована вместо emoji</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setFormData({ ...formData, isCustom: false, imageUrl: '' });
                          }}
                          className="text-red-600 hover:text-red-700 text-sm font-medium"
                        >
                          Удалить
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      📁 Или загрузить свою иконку
                    </label>
                    <input
                      type="file"
                      onChange={handleFileChange}
                      accept="image/*"
                      className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                    />
                    {selectedFile && (
                      <div className="mt-3 p-3 bg-white rounded-lg border border-blue-200">
                        <div className="flex items-center gap-3">
                          <img
                            src={URL.createObjectURL(selectedFile)}
                            alt="Preview"
                            className="w-16 h-16 object-contain bg-gray-50 rounded-lg p-2 shadow-sm"
                          />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-gray-900">{selectedFile.name}</p>
                            <p className="text-xs text-gray-500 mt-1">Файл будет загружен при сохранении</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setSelectedFile(null)}
                            className="text-red-600 hover:text-red-700 text-sm font-medium"
                          >
                            Удалить
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Порядок
                  </label>
                  <input
                    type="number"
                    value={formData.order}
                    onChange={(e) => {
                      const value = parseInt(e.target.value);
                      setFormData({ ...formData, order: isNaN(value) ? 0 : value });
                    }}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
                    required
                    min="1"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Автоматически: {categories.length > 0 ? Math.max(...categories.map(c => c.order)) + 1 : 1}
                  </p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-4">
                <button
                  type="submit"
                  disabled={uploading}
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {uploading ? '⏳ Загрузка...' : (editingCategory ? 'Сохранить изменения' : 'Создать категорию')}
                </button>
                {editingCategory && (
                  <button
                    type="button"
                    onClick={resetForm}
                    className="flex-1 sm:flex-none bg-gray-500 hover:bg-gray-600 text-white px-6 py-2 rounded-lg font-semibold transition-colors"
                  >
                    Отмена
                  </button>
                )}
              </div>
            </form>
          </div>
        )}

        {/* Desktop Table View */}
        <div className="hidden md:block bg-white rounded-xl shadow-md overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Порядок
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Emoji
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
                <tr key={category.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {category.order}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-2xl">
                    {category.isCustom && category.imageUrl ? (
                      <img
                        src={category.imageUrl}
                        alt={category.name}
                        className="w-8 h-8 object-contain"
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
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    {(category._count?.products || 0) > 0 && (
                      <button
                        onClick={() => handleManageProducts(category)}
                        className="text-purple-600 hover:text-purple-900 mr-4"
                      >
                        Продукты ({category._count?.products})
                      </button>
                    )}
                    <button
                      onClick={() => handleEdit(category)}
                      className="text-blue-600 hover:text-blue-900 mr-4"
                    >
                      Редактировать
                    </button>
                    <button
                      onClick={() => handleDelete(category.id)}
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

        {/* Mobile Card View */}
        <div className="md:hidden space-y-4">
          {categories.map((category) => (
            <div key={category.id} className="bg-white rounded-xl shadow-md p-4">
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
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-gray-900">{category.name}</h3>
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                      #{category.order}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500">{category.nameEn}</p>
                  <p className="text-sm text-gray-600 mt-1">
                    📦 {category._count?.products || 0} товаров
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pt-3 border-t border-gray-100">
                {(category._count?.products || 0) > 0 && (
                  <button
                    onClick={() => handleManageProducts(category)}
                    className="flex-1 min-w-[120px] bg-purple-50 text-purple-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-purple-100 transition-colors"
                  >
                    Продукты ({category._count?.products})
                  </button>
                )}
                <button
                  onClick={() => handleEdit(category)}
                  className="flex-1 min-w-[120px] bg-blue-50 text-blue-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors"
                >
                  Редактировать
                </button>
                <button
                  onClick={() => handleDelete(category.id)}
                  className="flex-1 min-w-[120px] bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors"
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Product Management Modal */}
        {showProductsModal && selectedCategory && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
              <div className="p-4 sm:p-6 border-b border-gray-200">
                <h2 className="text-xl sm:text-2xl font-bold text-gray-900">
                  Управление продуктами: {selectedCategory.name}
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Выберите продукты для перемещения в другую категорию
                </p>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                {categoryProducts.length === 0 ? (
                  <p className="text-gray-500 text-center py-8">
                    В этой категории пока нет продуктов
                  </p>
                ) : (
                  <div className="space-y-2">
                    {categoryProducts.map((product) => (
                      <label
                        key={product.id}
                        className="flex items-center gap-3 p-3 bg-gray-50 hover:bg-gray-100 rounded-lg cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selectedProductIds.includes(product.id)}
                          onChange={() => toggleProductSelection(product.id)}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <div className="flex items-center gap-3 flex-1">
                          {product.isCustom && product.imageUrl ? (
                            <img
                              src={product.imageUrl}
                              alt={product.name}
                              className="w-8 h-8 object-contain"
                            />
                          ) : (
                            <span className="text-2xl">{product.emoji}</span>
                          )}
                          <div>
                            <div className="font-medium text-gray-900">{product.name}</div>
                            <div className="text-sm text-gray-500">{product.nameEn}</div>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {categoryProducts.length > 0 && (
                <div className="p-4 sm:p-6 border-t border-gray-200 bg-gray-50">
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Переместить в категорию:
                    </label>
                    <select
                      value={targetCategoryId}
                      onChange={(e) => setTargetCategoryId(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
                    >
                      <option value="">Выберите категорию</option>
                      {categories
                        .filter((cat) => cat.id !== selectedCategory.id)
                        .map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.emoji} {cat.name}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-3">
                    <button
                      onClick={handleMoveProducts}
                      disabled={selectedProductIds.length === 0 || !targetCategoryId}
                      className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Переместить ({selectedProductIds.length})
                    </button>
                    <button
                      onClick={() => {
                        setShowProductsModal(false);
                        setSelectedProductIds([]);
                        setTargetCategoryId('');
                      }}
                      className="flex-1 sm:flex-none px-6 py-2 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-semibold transition-colors"
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
