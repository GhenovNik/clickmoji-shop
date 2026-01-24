'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ImportListModalProps {
  listId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

type ImportResultEntry = {
  name: string;
  category: string;
  note?: string;
};

type ImportResultSkipped = {
  name: string;
  reason: string;
};

type ImportResultFailed = {
  product?: { nameRu?: string };
  reason: string;
};

type ImportResults = {
  added: ImportResultEntry[];
  created: ImportResultEntry[];
  skipped: ImportResultSkipped[];
  failed: ImportResultFailed[];
};

export default function ImportListModal({
  listId,
  isOpen,
  onClose,
  onSuccess,
}: ImportListModalProps) {
  const [text, setText] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResults | null>(null);
  const router = useRouter();

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);

    if (!text.trim()) {
      setError('Введите список покупок');
      return;
    }

    setIsImporting(true);

    try {
      const res = await fetch('/api/lists/import-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(),
          listId,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Ошибка при импорте списка');
      }

      setResult(data.results);
      setText('');

      if (onSuccess) {
        onSuccess();
      }

      // Показываем результаты на 3 секунды, затем закрываем
      setTimeout(() => {
        handleClose();
        router.refresh();
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Произошла ошибка');
    } finally {
      setIsImporting(false);
    }
  };

  const handleClose = () => {
    setText('');
    setError('');
    setResult(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-900">Импорт списка</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {!result ? (
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label htmlFor="listText" className="block text-sm font-medium text-gray-700 mb-2">
                Вставьте список покупок
              </label>
              <textarea
                id="listText"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={`Примеры форматов:

- Молоко 2L
- Хлеб белый
- Яблоки красные 1кг

или

1. Помидоры 500г
2. Огурцы свежие
3. Сыр моцарелла

или просто:

Молоко, хлеб, яблоки, помидоры, огурцы`}
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none text-gray-900 font-mono text-sm"
                rows={12}
                autoFocus
                disabled={isImporting}
              />
              {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
            </div>

            <div className="bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg p-4 mb-4">
              <p className="text-sm text-gray-700 font-semibold mb-2 flex items-center gap-2">
                <span>✨</span>
                <span>AI автоматически:</span>
              </p>
              <ul className="text-sm text-gray-600 space-y-1 ml-6">
                <li>• Распознает товары в любом формате</li>
                <li>• Определит категории</li>
                <li>• Подберёт значки</li>
                <li>• Извлечёт количество и заметки</li>
                <li>• Создаст новые товары, если их нет в базе</li>
              </ul>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleClose}
                disabled={isImporting}
                className="flex-1 px-4 py-3 border-2 border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={isImporting || !text.trim()}
                className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isImporting ? (
                  <>
                    <span className="animate-spin">⏳</span>
                    <span>Импорт...</span>
                  </>
                ) : (
                  <>
                    <span>✨</span>
                    <span>Импортировать</span>
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-green-800 font-semibold mb-2 flex items-center gap-2">
                <span>✅</span>
                <span>Импорт завершён!</span>
              </p>
              <div className="text-sm text-green-700 space-y-1">
                <p>
                  • Добавлено товаров: <strong>{result.added?.length || 0}</strong>
                </p>
                <p>
                  • Создано новых товаров: <strong>{result.created?.length || 0}</strong>
                </p>
                {result.skipped?.length > 0 && (
                  <p>
                    • Пропущено (уже в списке): <strong>{result.skipped.length}</strong>
                  </p>
                )}
                {result.failed?.length > 0 && (
                  <p className="text-red-600">
                    • Ошибок: <strong>{result.failed.length}</strong>
                  </p>
                )}
              </div>
            </div>

            {result.created && result.created.length > 0 && (
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <p className="font-semibold text-purple-900 mb-2">Созданные товары:</p>
                <div className="space-y-1 text-sm text-purple-700">
                  {result.created.map((item, i) => (
                    <p key={i}>
                      • {item.name} ({item.category}){item.note && ` - ${item.note}`}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {result.skipped && result.skipped.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="font-semibold text-yellow-900 mb-2">Уже в списке:</p>
                <div className="space-y-1 text-sm text-yellow-700">
                  {result.skipped.map((item, i) => (
                    <p key={i}>
                      • {item.name} - {item.reason}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {result.failed && result.failed.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="font-semibold text-red-900 mb-2">Ошибки:</p>
                <div className="space-y-1 text-sm text-red-700">
                  {result.failed.map((item, i) => (
                    <p key={i}>
                      • {item.product?.nameRu || 'Unknown'}: {item.reason}
                    </p>
                  ))}
                </div>
              </div>
            )}

            <p className="text-center text-gray-500 text-sm">Закрытие через 3 секунды...</p>
          </div>
        )}
      </div>
    </div>
  );
}
