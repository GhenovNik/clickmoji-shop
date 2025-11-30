'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type List = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  _count: {
    items: number;
  };
};

export default function ListsPage() {
  const router = useRouter();
  const { data: session } = useSession();

  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!session?.user) {
      router.push('/auth/signin');
      return;
    }

    fetchLists();
  }, [session, router]);

  const fetchLists = async () => {
    try {
      const response = await fetch('/api/lists');
      if (response.ok) {
        const data = await response.json();

        // Если списков нет - создаем базовые
        if (data.length === 0) {
          const initResponse = await fetch('/api/lists/init', {
            method: 'POST',
          });
          if (initResponse.ok) {
            const newLists = await initResponse.json();
            setLists(newLists);
          }
        } else {
          setLists(data);
        }
      }
    } catch (error) {
      console.error('Error fetching lists:', error);
    } finally {
      setLoading(false);
    }
  };

  const createList = async () => {
    if (!newListName.trim()) {
      alert('Введите название списка');
      return;
    }

    setCreating(true);

    try {
      const response = await fetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newListName.trim(), isActive: false }),
      });

      if (response.ok) {
        setNewListName('');
        setShowCreateModal(false);
        fetchLists();
      }
    } catch (error) {
      console.error('Error creating list:', error);
      alert('Ошибка при создании списка');
    } finally {
      setCreating(false);
    }
  };

  const deleteList = async (listId: string, listName: string) => {
    if (!confirm(`Удалить список "${listName}"?`)) return;

    try {
      await fetch(`/api/lists/${listId}`, {
        method: 'DELETE',
      });
      fetchLists();
    } catch (error) {
      console.error('Error deleting list:', error);
      alert('Ошибка при удалении списка');
    }
  };

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
        {/* Back Button */}
        <div className="mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium"
          >
            <span>←</span>
            <span>На главную</span>
          </Link>
        </div>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 text-gray-900">📋 Мои списки</h1>
          <p className="text-gray-700">Выберите список для редактирования</p>
        </div>

        {/* Lists Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {lists.map((list) => (
            <div
              key={list.id}
              className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all relative group"
            >
              <Link href={`/lists/${list.id}`} className="block">
                <div className="text-center mb-4">
                  <div className="text-5xl mb-2">📋</div>
                  <h3 className="font-semibold text-lg mb-1 text-gray-900">
                    {list.name}
                  </h3>
                  <p className="text-sm text-gray-600">
                    {list._count.items} товаров
                  </p>
                </div>
              </Link>

              {/* Delete button */}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  deleteList(list.id, list.name);
                }}
                className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-8 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                title="Удалить список"
              >
                ✕
              </button>
            </div>
          ))}

          {/* Create New List Card */}
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all border-2 border-dashed border-gray-300 hover:border-blue-500 flex flex-col items-center justify-center min-h-[200px]"
          >
            <div className="text-5xl mb-2">➕</div>
            <h3 className="font-semibold text-lg text-gray-900">
              Создать новый список
            </h3>
          </button>
        </div>

        {/* Create Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl p-6 max-w-md w-full">
              <h2 className="text-2xl font-bold mb-4 text-gray-900">
                Создать новый список
              </h2>
              <input
                type="text"
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && createList()}
                placeholder="Название списка"
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4 text-gray-900"
                autoFocus
              />
              <div className="flex gap-4">
                <button
                  onClick={() => {
                    setShowCreateModal(false);
                    setNewListName('');
                  }}
                  className="flex-1 px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-semibold transition-colors"
                >
                  Отмена
                </button>
                <button
                  onClick={createList}
                  disabled={creating || !newListName.trim()}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-semibold transition-colors disabled:opacity-50"
                >
                  {creating ? 'Создание...' : 'Создать'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
