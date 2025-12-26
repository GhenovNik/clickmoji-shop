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
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
          >
            <span>←</span>
            <span>На главную</span>
          </Link>
        </div>

        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 text-gray-900">📋 Мои списки</h1>
          <p className="text-gray-700">Выберите список для редактирования</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {lists.map((list) => (
            <ListCard key={list.id} list={list} onDelete={deleteList} />
          ))}

          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all border-2 border-dashed border-gray-300 hover:border-blue-500 flex flex-col items-center justify-center min-h-[200px]"
          >
            <div className="text-5xl mb-2">➕</div>
            <h3 className="font-semibold text-lg text-gray-900">Создать новый список</h3>
          </button>
        </div>

        {showCreateModal && (
          <CreateListModal onClose={() => setShowCreateModal(false)} onCreate={createList} />
        )}
      </div>
    </div>
  );
}
