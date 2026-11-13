'use client';

import Image from 'next/image';
import { useState, useRef, useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { localizedName } from '@/lib/catalog-name';
import EmojiPicker from '../shared/EmojiPicker';
import ImagePreviewButton from '../shared/ImagePreviewButton';

interface Product {
  id: string;
  name: string;
  nameEn: string;
  emoji: string;
  isCustom: boolean;
  imageUrl: string | null;
  imageUrlEn?: string | null;
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
  nameEn?: string | null;
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
  // English version of a labelled picture; null when the picture has no text.
  imageUrlEn: string | null;
  variants?: ProductVariant[];
};

const MAX_UPLOAD_MB = 3;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

function readAsDataUrl(file: File, failureMessage: string) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(failureMessage));
    reader.readAsDataURL(file);
  });
}

export default function ProductForm({ product, categories, onSubmit, onCancel }: ProductFormProps) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const [formData, setFormData] = useState<FormData>({
    name: product?.name || '',
    nameEn: product?.nameEn || '',
    emoji: product?.emoji || '',
    categoryId: product?.categoryId || '',
    isCustom: product?.isCustom || false,
    imageUrl: product?.imageUrl || '',
    imageUrlEn: product?.imageUrlEn || null,
    variants: product?.variants || [],
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [generationDescription, setGenerationDescription] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  // The saved picture is the baseline for FR-3: "Вернуть прежнюю" and an ignored late
  // AI answer both fall back to it.
  const [savedImage] = useState(() => ({
    imageUrl: product?.imageUrl ?? '',
    imageUrlEn: product?.imageUrlEn ?? (null as string | null),
  }));
  // INV-1: every selection action bumps the sequence; an AI answer applies only while the
  // sequence still equals the value recorded at the request.
  const selectionSeq = useRef(0);
  const aiRequestSeq = useRef(0);

  useEffect(() => {
    if (!selectedFile) {
      setFilePreviewUrl(null);
      return;
    }
    const previewUrl = URL.createObjectURL(selectedFile);
    setFilePreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [selectedFile]);

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
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      alert(t('productForm.fileTooLarge', { maxMb: MAX_UPLOAD_MB }));
      e.target.value = '';
      return;
    }
    selectionSeq.current += 1;
    setSelectedFile(file);
  };

  // Every picture goes through /api/emoji/upload: the server normalizes it to the shared emoji
  // look and keeps it in the emoji library.
  const uploadToLibrary = async (base64: string, source: 'upload' | 'generated') => {
    const uploadRes = await fetch('/api/emoji/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64,
        productName: formData.nameEn || formData.name,
        name: formData.name,
        nameEn: formData.nameEn,
        source,
      }),
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || !uploadData.imageUrl) {
      throw new Error(uploadData.error || t('productForm.imageSaveFailed'));
    }
    return uploadData.imageUrl as string;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let imageUrl = formData.imageUrl;

    if (selectedFile) {
      setUploading(true);
      try {
        imageUrl = await uploadToLibrary(
          await readAsDataUrl(selectedFile, t('productForm.readFileFailed')),
          'upload'
        );
      } catch (error) {
        console.error('Error uploading image:', error);
        alert(error instanceof Error ? error.message : t('productForm.imageUploadFailed'));
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    if (!selectedFile && formData.isCustom && imageUrl && imageUrl.startsWith('data:image/')) {
      setUploading(true);
      try {
        imageUrl = await uploadToLibrary(imageUrl, 'generated');
      } catch (error) {
        console.error('Error uploading generated image:', error);
        alert(t('productForm.generatedSaveFailed'));
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
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('shared.nameRu')} *
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
            {t('shared.nameEn')} *
          </label>
          <input
            type="text"
            value={formData.nameEn}
            onChange={(e) => setFormData({ ...formData, nameEn: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
            required
          />
        </div>

        <div ref={dropdownRef} className="relative">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('productForm.category')} *
          </label>
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
                          <Image
                            src={selectedCat.imageUrl}
                            alt=""
                            width={24}
                            height={24}
                            className="w-6 h-6 object-contain"
                            unoptimized
                          />
                        ) : (
                          <span className="text-xl">{selectedCat.emoji}</span>
                        )}
                        <span>{localizedName(selectedCat, locale)}</span>
                      </>
                    ) : (
                      t('productForm.selectCategory')
                    );
                  })()}
                </>
              ) : (
                t('productForm.selectCategory')
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
                    <Image
                      src={cat.imageUrl}
                      alt={localizedName(cat, locale)}
                      width={24}
                      height={24}
                      className="w-6 h-6 object-contain"
                      unoptimized
                    />
                  ) : (
                    <span className="text-xl">{cat.emoji}</span>
                  )}
                  <span className="text-gray-900">{localizedName(cat, locale)}</span>
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
          productDescription={generationDescription}
          isRequired={!formData.isCustom}
          onGenerateImage={(url) => setFormData({ ...formData, imageUrl: url, isCustom: true })}
          onSelectLibraryImage={({ imageUrl, imageUrlEn }) => {
            // An English-only library picture fills the English field and keeps the main one.
            if (!imageUrl) {
              setFormData({ ...formData, imageUrlEn });
              return;
            }
            setSelectedFile(null);
            setFormData({ ...formData, imageUrl, imageUrlEn, isCustom: true });
          }}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('productForm.aiDescription')}
        </label>
        <textarea
          value={generationDescription}
          onChange={(e) => setGenerationDescription(e.target.value)}
          rows={3}
          placeholder={t('productForm.aiDescriptionPlaceholder')}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
        />
        <p className="mt-1 text-xs text-gray-500">{t('productForm.aiDescriptionHint')}</p>
      </div>

      <div className="border-t pt-4">
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={formData.isCustom}
            onChange={(e) => setFormData({ ...formData, isCustom: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-sm font-medium text-gray-700">{t('productForm.customImage')}</span>
        </label>

        {formData.isCustom && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('productForm.uploadImage')}
            </label>
            <input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {selectedFile && (
              <p className="text-sm text-gray-600 mt-1">
                {t('productForm.selectedFile', { name: selectedFile.name })}
              </p>
            )}
            {formData.imageUrl && !selectedFile && (
              <div className="mt-2">
                <p className="text-sm text-gray-600">{t('productForm.currentImage')}</p>
                <Image
                  src={formData.imageUrl}
                  alt="Current"
                  width={64}
                  height={64}
                  className="w-16 h-16 object-contain mt-1"
                  unoptimized
                />
              </div>
            )}
            {formData.imageUrlEn && (
              <div className="mt-2">
                <p className="text-sm text-gray-600">{t('productForm.englishVersion')}</p>
                <div className="flex items-center gap-3">
                  <Image
                    src={formData.imageUrlEn}
                    alt="English version"
                    width={64}
                    height={64}
                    className="w-16 h-16 object-contain mt-1"
                    unoptimized
                  />
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, imageUrlEn: null })}
                    className="text-sm text-red-600 hover:text-red-800"
                  >
                    {t('productForm.removeEnglishVersion')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-700">{t('productForm.variants')}</h3>
          <button
            type="button"
            onClick={addVariant}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            {t('productForm.addVariant')}
          </button>
        </div>

        {(formData.variants || []).length === 0 ? (
          <p className="text-sm text-gray-500">{t('productForm.noVariants')}</p>
        ) : (
          <div className="space-y-3">
            {(formData.variants || []).map((variant, index) => (
              <div key={variant.id || index} className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <input
                  type="text"
                  placeholder={t('shared.nameRu')}
                  value={variant.name}
                  onChange={(e) => updateVariant(index, 'name', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900"
                />
                <input
                  type="text"
                  placeholder={t('shared.nameEn')}
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
                  {t('shared.delete')}
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
          {uploading
            ? t('productForm.uploading')
            : product
              ? t('shared.saveChanges')
              : t('productForm.create')}
        </button>
        {product && (
          <button
            type="button"
            onClick={onCancel}
            className="bg-gray-500 hover:bg-gray-600 text-white px-6 py-2 rounded-lg font-semibold transition-colors"
          >
            {t('shared.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
