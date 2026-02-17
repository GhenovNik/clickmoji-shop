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
    <div className="bento-card group relative h-full flex flex-col">
      <Link
        href={`/lists/${list.id}`}
        className="flex-1 p-6 flex flex-col items-center justify-center"
      >
        <div className="text-6xl mb-4 group-hover:scale-110 transition-transform duration-300 drop-shadow-md">
          📋
        </div>
        <h3 className="font-heading font-black text-xl text-center leading-tight mb-2 tracking-tight group-hover:text-primary transition-colors">
          {list.name}
        </h3>
        <div className="flex items-center gap-1.5 bg-muted px-3 py-1 rounded-full">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {list._count.items} товаров
          </span>
          <ChevronRight size={12} className="text-muted-foreground" />
        </div>
      </Link>

      <button
        onClick={(e) => {
          e.preventDefault();
          onDelete(list.id, list.name);
        }}
        className="absolute top-3 right-3 p-2 bg-destructive/10 text-destructive rounded-full opacity-0 group-hover:opacity-100 transition-all hover:bg-destructive hover:text-white"
        title="Удалить список"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
