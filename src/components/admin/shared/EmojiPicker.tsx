'use client';

import Image from 'next/image';
import { useState } from 'react';

interface EmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
  productName: string;
  productNameEn?: string;
  productDescription?: string;
  isRequired?: boolean;
  onGenerateImage?: (imageUrl: string) => void;
  onSelectLibraryImage?: (imageUrl: string) => void;
}

interface LibraryItem {
  id: string;
  name: string;
  nameEn: string | null;
  tags: string[];
  imageUrl: string;
}

interface EmojiResult {
  emoji: string;
  label: string;
  shortcodes?: string[];
}

export default function EmojiPicker({
  value,
  onChange,
  productName,
  productNameEn,
  productDescription,
  isRequired = false,
  onGenerateImage,
  onSelectLibraryImage,
}: EmojiPickerProps) {
  const [results, setResults] = useState<EmojiResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');

  const searchLibrary = async (query: string) => {
    setLibraryLoading(true);
    setLibraryError('');
    try {
      const res = await fetch(`/api/emoji/library?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setLibraryItems(data.items || []);
    } catch (error) {
      console.error('Error searching emoji library:', error);
      setLibraryItems([]);
      setLibraryError('Не удалось загрузить библиотеку');
    } finally {
      setLibraryLoading(false);
    }
  };

  const toggleLibrary = () => {
    if (libraryOpen) {
      setLibraryOpen(false);
      return;
    }
    setLibraryOpen(true);
    setLibraryQuery(productName);
    void searchLibrary(productName);
  };

  const searchEmoji = async () => {
    if (!productName) {
      alert('Введите название для поиска emoji');
      return;
    }

    setSearching(true);
    try {
      const res = await fetch(`/api/emoji/search?q=${encodeURIComponent(productName)}`);
      const data = await res.json();
      setResults(data.results || []);
    } catch (error) {
      console.error('Error searching emoji:', error);
      alert('Ошибка при поиске emoji');
    } finally {
      setSearching(false);
    }
  };

  const generateAI = async () => {
    const nameToUse = productNameEn || productName;
    if (!nameToUse) {
      alert('Введите название для генерации иконки');
      return;
    }

    setGenerating(true);
    try {
      // Step 1: Generate a base64 preview without persisting it.
      const generateRes = await fetch('/api/emoji/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName: nameToUse,
          description: productDescription?.trim() || undefined,
        }),
      });

      const generateData = await generateRes.json();

      if (!generateRes.ok || !generateData.base64) {
        alert(generateData.error || 'Ошибка при генерации иконки');
        return;
      }

      onGenerateImage?.(generateData.base64);
      alert('✅ AI иконка сгенерирована (предпросмотр). Сохранится после нажатия "Сохранить".');
    } catch (error) {
      console.error('Error generating AI emoji:', error);
      alert('Ошибка при генерации иконки');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="md:col-span-2">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Emoji (по умолчанию) {isRequired && '*'}
      </label>
      <div className="flex flex-col gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-2xl text-gray-900"
          placeholder={isRequired ? '🍎' : '🍎 (опционально)'}
          required={isRequired}
        />
        <div className={`grid gap-2 ${onSelectLibraryImage ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <button
            type="button"
            onClick={searchEmoji}
            disabled={searching || !productName}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
          >
            {searching ? 'Поиск...' : '🔍 Подобрать'}
          </button>
          {onGenerateImage && (
            <button
              type="button"
              onClick={generateAI}
              disabled={generating || (!productNameEn && !productName)}
              className="px-4 py-2 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              title="Сгенерировать иконку с помощью AI"
            >
              {generating ? '⏳ Генерация...' : '🎨 AI'}
            </button>
          )}
          {onSelectLibraryImage && (
            <button
              type="button"
              onClick={toggleLibrary}
              aria-expanded={libraryOpen}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold transition-colors text-sm"
              title="Выбрать готовую картинку из библиотеки"
            >
              📚 Библиотека
            </button>
          )}
        </div>
      </div>
      {libraryOpen && onSelectLibraryImage && (
        <div className="mt-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex gap-2">
            <input
              type="search"
              value={libraryQuery}
              onChange={(event) => setLibraryQuery(event.target.value)}
              onKeyDown={(event) => {
                // The picker sits inside the product form: Enter searches instead of saving it.
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void searchLibrary(libraryQuery);
                }
              }}
              placeholder="Название или тег"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900"
            />
            <button
              type="button"
              onClick={() => void searchLibrary(libraryQuery)}
              className="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm text-gray-700 hover:border-emerald-500"
            >
              Найти
            </button>
          </div>
          {libraryLoading && <p className="mt-2 text-sm text-gray-500">Поиск…</p>}
          {libraryError && <p className="mt-2 text-sm text-red-600">{libraryError}</p>}
          {!libraryLoading && !libraryError && libraryItems.length === 0 && (
            <p className="mt-2 text-sm text-gray-500">В библиотеке ничего не найдено</p>
          )}
          {libraryItems.length > 0 && (
            <div className="mt-2 grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-64 overflow-y-auto">
              {libraryItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelectLibraryImage(item.imageUrl);
                    setLibraryOpen(false);
                  }}
                  className="flex flex-col items-center gap-1 p-1 bg-white rounded-lg border border-gray-200 hover:border-emerald-500"
                  title={[item.name, item.nameEn, ...item.tags].filter(Boolean).join(' · ')}
                >
                  <span className="h-12 w-12 flex items-center justify-center overflow-hidden">
                    <Image
                      src={item.imageUrl}
                      alt={item.name}
                      width={48}
                      height={48}
                      className="h-12 w-12 object-contain"
                    />
                  </span>
                  <span className="w-full truncate text-[11px] text-gray-700">{item.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {results.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
          {results.map((result, index) => (
            <button
              key={index}
              type="button"
              onClick={() => {
                onChange(result.emoji);
                setResults([]);
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
  );
}
