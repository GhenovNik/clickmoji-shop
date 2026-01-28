'use client';

import { useState, useRef, useEffect } from 'react';
import { useUploadThing } from '@/lib/uploadthing';
import EmojiPicker from '../shared/EmojiPicker';

interface Product {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  categoryId: string;
  variants?: ProductVariant[];
}

interface ProductVariant {
  id?: string;
  name: string;
  nameEn: string;
  emoji: string;
}

interface Category {
  id: string;
  name: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
}

interface ProductFormProps {
  product: Product | null;
  categories: Category[];
  onSubmit: (data: FormData, imageUrl?: string) => Promise<void>;
  onCancel: () => void;
}

export type FormData = {
  name: string;
  nameEn: string;
  emoji: string;
  categoryId: string;
  isCustom: boolean;
  imageUrl: string;
  variants?: ProductVariant[];
};

export default function ProductForm({ product, categories, onSubmit, onCancel }: ProductFormProps) {
  const [formData, setFormData] = useState<FormData>({
    name: product?.name || '',
    nameEn: product?.nameEn || '',
    emoji: product?.emoji || '',
    categoryId: product?.categoryId || '',
    isCustom: product?.isCustom || false,
    imageUrl: product?.imageUrl || '',
    variants: product?.variants || [],
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { startUpload } = useUploadThing('productImage');

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let imageUrl = formData.imageUrl;

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

    await onSubmit(formData, imageUrl);
  };

  const updateVariant = (index: number, key: keyof ProductVariant, value: string) => {
    const updated = [...(formData.variants || [])];
    const variant = updated[index];
    if (!variant) return;
    updated[index] = { ...variant, [key]: value };
    setFormData({ ...formData, variants: updated });
  };

  const addVariant = () => {
    const updated = [...(formData.variants || [])];
    updated.push({ name: '', nameEn: '', emoji: '' });
    setFormData({ ...formData, variants: updated });
  };

  const removeVariant = (index: number) => {
    const updated = [...(formData.variants || [])];
    updated.splice(index, 1);
    setFormData({ ...formData, variants: updated });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 overflow-x-hidden">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Название (RU) *</label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Название (EN) *</label>
          <input
            type="text"
            value={formData.nameEn}
            onChange={(e) => setFormData({ ...formData, nameEn: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
            required
          />
        </div>

        <div ref={dropdownRef} className="relative">
          <label className="block text-sm font-medium text-gray-700 mb-1">Категория *</label>
          <button
            type="button"
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 text-left flex items-center justify-between bg-white"
          >
            <span className="flex items-center gap-2">
              {formData.categoryId ? (
                <>
                  {(() => {
                    const selectedCat = categories.find((c) => c.id === formData.categoryId);
                    return selectedCat ? (
                      <>
                        {selectedCat.isCustom && selectedCat.imageUrl ? (
                          <img
                            src={selectedCat.imageUrl}
                            alt=""
                            className="w-6 h-6 object-contain"
                          />
                        ) : (
                          <span className="text-xl">{selectedCat.emoji}</span>
                        )}
                        <span>{selectedCat.name}</span>
                      </>
                    ) : (
                      'Выберите категорию'
                    );
                  })()}
                </>
              ) : (
                'Выберите категорию'
              )}
            </span>
            <span className="text-gray-400">{isDropdownOpen ? '▲' : '▼'}</span>
          </button>

          {isDropdownOpen && (
            <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => {
                    setFormData({ ...formData, categoryId: cat.id });
                    setIsDropdownOpen(false);
                  }}
                  className="w-full px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-left transition-colors"
                >
                  {cat.isCustom && cat.imageUrl ? (
                    <img src={cat.imageUrl} alt={cat.name} className="w-6 h-6 object-contain" />
                  ) : (
                    <span className="text-xl">{cat.emoji}</span>
                  )}
                  <span className="text-gray-900">{cat.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <EmojiPicker
          value={formData.emoji}
          onChange={(emoji) => setFormData({ ...formData, emoji })}
          productName={formData.name}
          productNameEn={formData.nameEn}
          isRequired={!formData.isCustom}
          onGenerateImage={(url) => setFormData({ ...formData, imageUrl: url, isCustom: true })}
        />
      </div>

      <div className="border-t pt-4">
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={formData.isCustom}
            onChange={(e) => setFormData({ ...formData, isCustom: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-sm font-medium text-gray-700">Кастомное изображение</span>
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
              <p className="text-sm text-gray-600 mt-1">Выбран: {selectedFile.name}</p>
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

      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-700">Варианты</h3>
          <button
            type="button"
            onClick={addVariant}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            + Добавить вариант
          </button>
        </div>

        {(formData.variants || []).length === 0 ? (
          <p className="text-sm text-gray-500">Нет вариантов. Добавьте, если нужны опции.</p>
        ) : (
          <div className="space-y-3">
            {(formData.variants || []).map((variant, index) => (
              <div key={variant.id || index} className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <input
                  type="text"
                  placeholder="Название (RU)"
                  value={variant.name}
                  onChange={(e) => updateVariant(index, 'name', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                />
                <input
                  type="text"
                  placeholder="Название (EN)"
                  value={variant.nameEn}
                  onChange={(e) => updateVariant(index, 'nameEn', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                />
                <input
                  type="text"
                  placeholder="Emoji"
                  value={variant.emoji}
                  onChange={(e) => updateVariant(index, 'emoji', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                />
                <button
                  type="button"
                  onClick={() => removeVariant(index)}
                  className="text-red-600 hover:text-red-800 text-sm font-medium"
                >
                  Удалить
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <button
          type="submit"
          disabled={uploading}
          className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors disabled:opacity-50"
        >
          {uploading ? 'Загрузка...' : product ? 'Сохранить изменения' : 'Создать продукт'}
        </button>
        {product && (
          <button
            type="button"
            onClick={onCancel}
            className="bg-gray-500 hover:bg-gray-600 text-white px-6 py-2 rounded-lg font-semibold transition-colors"
          >
            Отмена
          </button>
        )}
      </div>
    </form>
  );
}
