'use client';

interface ProductSelectionBarProps {
  count: number;
  adding: boolean;
  onAddToList: () => void;
}

export default function ProductSelectionBar({
  count,
  adding,
  onAddToList,
}: ProductSelectionBarProps) {
  if (count === 0) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg">
      <div className="max-w-4xl mx-auto flex items-center justify-between">
        <div className="text-lg font-semibold">Выбрано: {count}</div>
        <button
          onClick={onAddToList}
          disabled={adding}
          className="bg-green-500 hover:bg-green-600 text-white px-8 py-3 rounded-xl font-semibold transition-colors disabled:opacity-50"
        >
          {adding ? 'Добавление...' : 'Добавить в список'}
        </button>
      </div>
    </div>
  );
}
