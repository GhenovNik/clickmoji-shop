'use client';

import { useState } from 'react';
import { useUploadThing } from '@/lib/uploadthing';
import EmojiPicker from '../shared/EmojiPicker';

interface Category {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  order: number;
}

interface CategoryFormProps {
  category: Category | null;
  nextOrder: number;
  onSubmit: (data: FormData, imageUrl?: string) => Promise<void>;
  onCancel: () => void;
}

export type FormData = {
  name: string;
  nameEn: string;
  emoji: string;
  order: number;
  isCustom: boolean;
  imageUrl: string;
};

export default function CategoryForm({
  category,
  nextOrder,
  onSubmit,
  onCancel,
}: CategoryFormProps) {
  const [formData, setFormData] = useState<FormData>({
    name: category?.name || '',
    nameEn: category?.nameEn || '',
    emoji: category?.emoji || '',
    order: category?.order || nextOrder,
    isCustom: category?.isCustom || false,
    imageUrl: category?.imageUrl || '',
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const { startUpload } = useUploadThing('productImage');

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let uploadedImageUrl = formData.imageUrl;

    if (selectedFile) {
      setUploading(true);
      try {
        const uploadedFiles = await startUpload([selectedFile]);
        if (uploadedFiles && uploadedFiles[0]) {
          uploadedImageUrl = uploadedFiles[0].url;
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

    await onSubmit(formData, uploadedImageUrl);
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

        <EmojiPicker
          value={formData.emoji}
          onChange={(emoji) => setFormData({ ...formData, emoji })}
          productName={formData.name}
          productNameEn={formData.nameEn}
          isRequired={!selectedFile && !formData.imageUrl}
          onGenerateImage={(url) => setFormData({ ...formData, imageUrl: url, isCustom: true })}
        />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Порядок *</label>
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
          <p className="text-xs text-gray-500 mt-1">Рекомендуемый: {nextOrder}</p>
        </div>
      </div>

      {/* AI Generated Image Preview */}
      {formData.imageUrl && !selectedFile && (
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

      {/* File Upload */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Или загрузить собственное изображение
        </label>
        <input
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        {selectedFile && (
          <div className="mt-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
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

      <div className="flex flex-col sm:flex-row gap-4">
        <button
          type="submit"
          disabled={uploading}
          className="flex-1 bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uploading ? '⏳ Загрузка...' : category ? 'Сохранить изменения' : 'Создать категорию'}
        </button>
        {category && (
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 sm:flex-none bg-gray-500 hover:bg-gray-600 text-white px-6 py-2 rounded-lg font-semibold transition-colors"
          >
            Отмена
          </button>
        )}
      </div>
    </form>
  );
}
