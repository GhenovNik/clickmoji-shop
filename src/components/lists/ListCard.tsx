'use client';

import Link from 'next/link';
import type { List } from '@/hooks/useListsManagement';

interface ListCardProps {
  list: List;
  onDelete: (listId: string, listName: string) => void;
}

export default function ListCard({ list, onDelete }: ListCardProps) {
  return (
    <div className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all relative group">
      <Link href={`/lists/${list.id}`} className="block">
        <div className="text-center mb-4">
          <div className="text-5xl mb-2">📋</div>
          <h3 className="font-semibold text-lg mb-1 text-gray-900">{list.name}</h3>
          <p className="text-sm text-gray-600">{list._count.items} товаров</p>
        </div>
      </Link>

      <button
        onClick={(e) => {
          e.preventDefault();
          onDelete(list.id, list.name);
        }}
        className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-8 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        title="Удалить список"
      >
        ✕
      </button>
    </div>
  );
}
