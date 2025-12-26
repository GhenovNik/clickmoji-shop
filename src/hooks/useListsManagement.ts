'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';

export type List = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  _count: {
    items: number;
  };
};

export function useListsManagement() {
  const router = useRouter();
  const { data: session } = useSession();

  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLists = async () => {
    try {
      const response = await fetch('/api/lists');
      if (response.ok) {
        const data = await response.json();

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

  useEffect(() => {
    if (!session?.user) {
      router.push('/auth/signin');
      return;
    }

    fetchLists();
  }, [session, router]);

  const createList = async (name: string) => {
    if (!name.trim()) {
      alert('Введите название списка');
      return false;
    }

    try {
      const response = await fetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), isActive: false }),
      });

      if (response.ok) {
        await fetchLists();
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error creating list:', error);
      alert('Ошибка при создании списка');
      return false;
    }
  };

  const deleteList = async (listId: string, listName: string) => {
    if (!confirm(`Удалить список "${listName}"?`)) return;

    try {
      await fetch(`/api/lists/${listId}`, {
        method: 'DELETE',
      });
      await fetchLists();
    } catch (error) {
      console.error('Error deleting list:', error);
      alert('Ошибка при удалении списка');
    }
  };

  return {
    lists,
    loading,
    createList,
    deleteList,
  };
}
