'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useUploadThing } from '@/lib/uploadthing';

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

interface Category {
  id: string;
  name: string;
  emoji: string;
}

export default function AdminProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sortField, setSortField] = useState<'name' | 'category' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [emojiResults, setEmojiResults] = useState<Array<{ emoji: string; label: string; shortcodes?: string[] }>>([]);
  const [searchingEmoji, setSearchingEmoji] = useState(false);
  const [generatingAI, setGeneratingAI] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkImportText, setBulkImportText] = useState('');
  const [bulkImporting, setBulkImporting] = useState(false);

  const { startUpload } = useUploadThing("productImage");

  const [formData, setFormData] = useState({
    name: '',
    nameEn: '',
    emoji: '',
    categoryId: '',
    isCustom: false,
    imageUrl: '',
  });

  useEffect(() => {
    fetchProducts();
    fetchCategories();
  }, []);

  const fetchProducts = async () => {
    try {
      const res = await fetch('/api/products');
      const data = await res.json();
      setProducts(data);
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const res = await fetch('/api/categories');
      const data = await res.json();
      setCategories(data);
    } catch (error) {
      console.error('Error fetching categories:', error);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const searchEmoji = async () => {
    if (!formData.name) {
      alert('Введите название продукта для поиска emoji');
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
      alert('Введите название продукта для генерации иконки');
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let imageUrl = formData.imageUrl;

    // Если выбран файл, загружаем его
    if (selectedFile) {
      setUploading(true);
      try {
        const uploadResult = await startUpload([selectedFile]);
        if (uploadResult && uploadResult[0]) {
          imageUrl = uploadResult[0].url;
        }
      } catch (error) {
        console.error('Error uploading image:', error);
        alert('Ошибка при загрузке изображения');
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    try {
      const url = editingProduct
        ? `/api/products/${editingProduct.id}`
        : '/api/products';
      const method = editingProduct ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          isCustom: formData.isCustom || !!imageUrl,
          imageUrl: imageUrl || null,
        }),
      });

      if (res.ok) {
        await fetchProducts();
        resetForm();
      } else {
        alert('Ошибка при сохранении продукта');
      }
    } catch (error) {
      console.error('Error saving product:', error);
      alert('Ошибка при сохранении продукта');
    }
  };

  const handleEdit = (product: Product) => {
    setEditingProduct(product);
    setFormData({
      name: product.name,
      nameEn: product.nameEn,
      emoji: product.emoji,
      categoryId: product.categoryId,
      isCustom: product.isCustom,
      imageUrl: product.imageUrl || '',
    });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Вы уверены?')) {
      return;
    }

    try {
      const res = await fetch(`/api/products/${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        await fetchProducts();
      } else {
        alert('Ошибка при удалении продукта');
      }
    } catch (error) {
      console.error('Error deleting product:', error);
      alert('Ошибка при удалении продукта');
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      nameEn: '',
      emoji: '',
      categoryId: '',
      isCustom: false,
      imageUrl: '',
    });
    setEditingProduct(null);
    setSelectedFile(null);
    setShowForm(false);
    setEmojiResults([]);
  };

  const handleBulkImport = async () => {
    if (!bulkImportText.trim()) {
      alert('Введите названия продуктов (по одному на строке)');
      return;
    }

    // Разбиваем текст на строки и фильтруем пустые
    const productNames = bulkImportText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (productNames.length === 0) {
      alert('Не найдено названий продуктов');
      return;
    }

    setBulkImporting(true);

    try {
      const res = await fetch('/api/products/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productNames }),
      });

      const data = await res.json();

      if (res.ok) {
        const { results } = data;
        alert(
          `✅ Импорт завершен!\n` +
          `Добавлено: ${results.success.length}\n` +
          `Ошибок: ${results.failed.length}`
        );

        if (results.failed.length > 0) {
          console.log('Failed products:', results.failed);
        }

        setShowBulkImport(false);
        setBulkImportText('');
        await fetchProducts();
      } else {
        alert(`Ошибка: ${data.error || 'Не удалось импортировать продукты'}`);
      }
    } catch (error) {
      console.error('Bulk import error:', error);
      alert('Ошибка при импорте продуктов');
    } finally {
      setBulkImporting(false);
    }
  };

  // Обработчик клика на заголовок для сортировки
  const handleSort = (field: 'name' | 'category') => {
    if (sortField === field) {
      // Если кликнули на тот же заголовок - меняем направление
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      // Если кликнули на новый заголовок - сортируем по возрастанию
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Сортировка продуктов
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
            <h1 className="text-4xl font-bold text-gray-900">Продукты</h1>
            <div className="flex gap-3">
              <button
                onClick={() => setShowBulkImport(!showBulkImport)}
                className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors"
              >
                📦 Множественное добавление
              </button>
              <button
                onClick={() => setShowForm(!showForm)}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors"
              >
                {showForm ? 'Отмена' : '+ Добавить продукт'}
              </button>
            </div>
          </div>
        </div>

        {showForm && (
          <div className="bg-white p-6 rounded-xl shadow-md mb-8">
            <h2 className="text-2xl font-bold mb-4">
              {editingProduct ? 'Редактировать продукт' : 'Новый продукт'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Название (RU) *
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
                    Название (EN) *
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
                    Категория *
                  </label>
                  <select
                    value={formData.categoryId}
                    onChange={(e) => setFormData({ ...formData, categoryId: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
                    required
                  >
                    <option value="">Выберите категорию</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.emoji} {cat.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Emoji (по умолчанию) {!formData.isCustom && '*'}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={formData.emoji}
                      onChange={(e) => setFormData({ ...formData, emoji: e.target.value })}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-2xl text-gray-900"
                      placeholder={formData.isCustom ? "🍎 (опционально)" : "🍎"}
                      required={!formData.isCustom}
                    />
                    <button
                      type="button"
                      onClick={searchEmoji}
                      disabled={searchingEmoji || !formData.name}
                      className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      {searchingEmoji ? 'Поиск...' : '🔍 Подобрать'}
                    </button>
                    <button
                      type="button"
                      onClick={generateAIEmoji}
                      disabled={generatingAI || !formData.name}
                      className="px-4 py-2 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                      title="Сгенерировать иконку с помощью AI"
                    >
                      {generatingAI ? '⏳ Генерация...' : '🎨 AI'}
                    </button>
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
                </div>
              </div>

              <div className="border-t pt-4">
                <label className="flex items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    checked={formData.isCustom}
                    onChange={(e) => setFormData({ ...formData, isCustom: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Кастомное изображение
                  </span>
                </label>

                {formData.isCustom && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Загрузить изображение
                    </label>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    {selectedFile && (
                      <p className="text-sm text-gray-600 mt-1">
                        Выбран: {selectedFile.name}
                      </p>
                    )}
                    {formData.imageUrl && !selectedFile && (
                      <div className="mt-2">
                        <p className="text-sm text-gray-600">Текущее изображение:</p>
                        <img
                          src={formData.imageUrl}
                          alt="Current"
                          className="w-16 h-16 object-contain mt-1"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex gap-4">
                <button
                  type="submit"
                  disabled={uploading}
                  className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors disabled:opacity-50"
                >
                  {uploading ? 'Загрузка...' : editingProduct ? 'Сохранить изменения' : 'Создать продукт'}
                </button>
                {editingProduct && (
                  <button
                    type="button"
                    onClick={resetForm}
                    className="bg-gray-500 hover:bg-gray-600 text-white px-6 py-2 rounded-lg font-semibold transition-colors"
                  >
                    Отмена
                  </button>
                )}
              </div>
            </form>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Изображение
                  </th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                    onClick={() => handleSort('name')}
                  >
                    <div className="flex items-center gap-1">
                      Название
                      {sortField === 'name' && (
                        <span className="text-blue-600">
                          {sortDirection === 'asc' ? '↑' : '↓'}
                        </span>
                      )}
                    </div>
                  </th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                    onClick={() => handleSort('category')}
                  >
                    <div className="flex items-center gap-1">
                      Категория
                      {sortField === 'category' && (
                        <span className="text-blue-600">
                          {sortDirection === 'asc' ? '↑' : '↓'}
                        </span>
                      )}
                    </div>
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Тип
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortedProducts.map((product) => (
                  <tr key={product.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      {product.isCustom && product.imageUrl ? (
                        <img
                          src={product.imageUrl}
                          alt={product.name}
                          className="w-12 h-12 object-contain"
                        />
                      ) : (
                        <span className="text-3xl">{product.emoji}</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{product.name}</div>
                      <div className="text-sm text-gray-500">{product.nameEn}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {product.category.emoji} {product.category.name}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                        product.isCustom
                          ? 'bg-purple-100 text-purple-800'
                          : 'bg-green-100 text-green-800'
                      }`}>
                        {product.isCustom ? 'Custom' : 'Emoji'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => handleEdit(product)}
                        className="text-blue-600 hover:text-blue-900 mr-4"
                      >
                        Редактировать
                      </button>
                      <button
                        onClick={() => handleDelete(product.id)}
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

        {/* Bulk Import Modal */}
        {showBulkImport && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
              <div className="p-6 border-b border-gray-200">
                <h2 className="text-2xl font-bold text-gray-900">
                  📦 Множественное добавление продуктов
                </h2>
                <p className="text-sm text-gray-500 mt-2">
                  Введите названия продуктов (по одному на строке). AI автоматически переведет их на русский и английский, распределит по категориям и подберет emoji.
                </p>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Названия продуктов (по одному на строке):
                  </label>
                  <textarea
                    value={bulkImportText}
                    onChange={(e) => setBulkImportText(e.target.value)}
                    placeholder="авокадо&#10;хумус&#10;тофу&#10;кинза&#10;базилик"
                    className="w-full h-64 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-gray-900 font-mono"
                    disabled={bulkImporting}
                  />
                  <p className="text-xs text-gray-500 mt-2">
                    Продуктов: {bulkImportText.split('\n').filter(l => l.trim()).length}
                  </p>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                  <h3 className="text-sm font-semibold text-blue-900 mb-2">ℹ️ Как это работает:</h3>
                  <ul className="text-sm text-blue-800 space-y-1">
                    <li>• AI переведет названия на русский и английский</li>
                    <li>• Автоматически распределит по существующим категориям</li>
                    <li>• Подберет Unicode emoji (🍎, 🥕) где возможно</li>
                    <li>• Если emoji не найден, будет использован 📦</li>
                  </ul>
                </div>
              </div>

              <div className="p-6 border-t border-gray-200 bg-gray-50">
                <div className="flex gap-3">
                  <button
                    onClick={handleBulkImport}
                    disabled={bulkImporting || !bulkImportText.trim()}
                    className="flex-1 bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {bulkImporting ? '⏳ Обработка...' : '🚀 Импортировать'}
                  </button>
                  <button
                    onClick={() => {
                      setShowBulkImport(false);
                      setBulkImportText('');
                    }}
                    disabled={bulkImporting}
                    className="px-6 py-3 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
