'use client';

import { useState } from 'react';

interface BulkImportModalProps {
  onClose: () => void;
  onImportComplete: () => void;
}

export default function BulkImportModal({ onClose, onImportComplete }: BulkImportModalProps) {
  const [bulkImportText, setBulkImportText] = useState('');
  const [bulkImporting, setBulkImporting] = useState(false);

  const handleBulkImport = async () => {
    if (!bulkImportText.trim()) {
      alert('Введите названия продуктов (по одному на строке)');
      return;
    }

    const productNames = bulkImportText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

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

        setBulkImportText('');
        onImportComplete();
        onClose();
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

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 sm:p-6 border-b border-gray-200">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-900">
            📦 Множественное добавление продуктов
          </h2>
          <p className="text-sm text-gray-500 mt-2">
            Введите названия продуктов (по одному на строке). AI автоматически переведет их на
            русский и английский, распределит по категориям и подберет emoji.
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
              placeholder={'авокадо\nхумус\nтофу\nкинза\nбазилик'}
              className="w-full h-64 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-gray-900 font-mono"
              disabled={bulkImporting}
            />
            <p className="text-xs text-gray-500 mt-2">
              Продуктов: {bulkImportText.split('\n').filter((l) => l.trim()).length}
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
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleBulkImport}
              disabled={bulkImporting || !bulkImportText.trim()}
              className="flex-1 bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {bulkImporting ? '⏳ Обработка...' : '🚀 Импортировать'}
            </button>
            <button
              onClick={onClose}
              disabled={bulkImporting}
              className="flex-1 sm:flex-none px-6 py-3 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-semibold transition-colors disabled:opacity-50"
            >
              Отмена
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
