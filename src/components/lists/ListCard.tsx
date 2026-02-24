'use client';

import Link from 'next/link';
import type { List } from '@/hooks/useListsManagement';
import { Trash2, ChevronRight } from 'lucide-react';

interface ListCardProps {
  list: List;
  onDelete: (listId: string, listName: string) => void;
}

export default function ListCard({ list, onDelete }: ListCardProps) {
  return (
    <div className="group relative h-full flex flex-col rounded-2xl border border-slate-200/80 bg-white/90 backdrop-blur-sm shadow-sm hover:shadow-md transition-all">
      <Link
        href={`/lists/${list.id}`}
        className="flex-1 p-5 sm:p-6 flex flex-col items-center justify-center"
      >
        <div className="text-5xl sm:text-6xl mb-3 group-hover:scale-105 transition-transform duration-300">
          📋
        </div>
        <h3 className="font-semibold text-lg sm:text-xl text-center leading-tight mb-2 text-slate-900 group-hover:text-primary transition-colors">
          {list.name}
        </h3>
        <div className="flex items-center gap-1.5 bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full border border-slate-200">
          <span className="text-[11px] font-medium uppercase tracking-wide">
            {list._count.items} товаров
          </span>
          <ChevronRight size={12} className="text-slate-500" />
        </div>
      </Link>

      <button
        onClick={(e) => {
          e.preventDefault();
          onDelete(list.id, list.name);
        }}
        className="absolute top-3 right-3 p-2 bg-rose-50 text-rose-500 rounded-full opacity-0 group-hover:opacity-100 transition-all hover:bg-rose-500 hover:text-white"
        title="Удалить список"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
