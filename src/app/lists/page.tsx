'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { useListsManagement } from '@/hooks/useListsManagement';
import ListCard from '@/components/lists/ListCard';
import CreateListModal from '@/components/lists/CreateListModal';

export default function ListsPage() {
  const { data: session } = useSession();
  const { lists, loading, createList, deleteList } = useListsManagement();
  const [showCreateModal, setShowCreateModal] = useState(false);

  if (loading || !session?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-bounce text-4xl">🛒</div>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <div className="mb-7">
        <h1 className="text-3xl sm:text-4xl font-semibold mb-2 text-slate-900 tracking-tight">
          Мои списки
        </h1>
        <p className="text-slate-600 font-normal">Управляйте своими покупками просто</p>
      </div>

      <div className="grid grid-cols-2 xs:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {lists.map((list) => (
          <ListCard key={list.id} list={list} onDelete={deleteList} />
        ))}

        <button
          onClick={() => setShowCreateModal(true)}
          className="rounded-2xl border border-dashed border-slate-300 p-6 flex flex-col items-center justify-center gap-3 min-h-[160px] bg-white/90 hover:border-primary hover:bg-white shadow-sm hover:shadow-md group transition-all"
        >
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary group-hover:text-white transition-colors">
            <span className="text-2xl font-bold">+</span>
          </div>
          <span className="font-medium text-sm text-slate-800 text-center">Новый список</span>
        </button>
      </div>

      {showCreateModal && (
        <CreateListModal onClose={() => setShowCreateModal(false)} onCreate={createList} />
      )}
    </div>
  );
}
