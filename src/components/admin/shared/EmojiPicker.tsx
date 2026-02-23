'use client';

import { useState } from 'react';

interface EmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
  productName: string;
  productNameEn?: string;
  isRequired?: boolean;
  onGenerateImage?: (imageUrl: string) => void;
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
  isRequired = false,
  onGenerateImage,
}: EmojiPickerProps) {
  const [results, setResults] = useState<EmojiResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [generating, setGenerating] = useState(false);

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
      // Step 1: Generate emoji (получаем base64 preview)
      const generateRes = await fetch('/api/emoji/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productName: nameToUse }),
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
        <div className="grid grid-cols-2 gap-2">
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
        </div>
      </div>
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
