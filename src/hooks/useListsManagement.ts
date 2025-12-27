'use client';

import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

// API functions
const fetchListsAPI = async (): Promise<List[]> => {
  const response = await fetch('/api/lists');
  if (!response.ok) throw new Error('Failed to fetch lists');

  const data = await response.json();

  // If no lists exist, initialize
  if (data.length === 0) {
    const initResponse = await fetch('/api/lists/init', {
      method: 'POST',
    });
    if (!initResponse.ok) throw new Error('Failed to initialize lists');
    return initResponse.json();
  }

  return data;
};

const createListAPI = async (name: string) => {
  const response = await fetch('/api/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), isActive: false }),
  });
  if (!response.ok) throw new Error('Failed to create list');
  return response.json();
};

const deleteListAPI = async (listId: string) => {
  const response = await fetch(`/api/lists/${listId}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to delete list');
  return response.json();
};

export function useListsManagement() {
  const router = useRouter();
  const { data: session } = useSession();
  const queryClient = useQueryClient();

  // Redirect if not authenticated (must be in useEffect for SSR)
  useEffect(() => {
    if (!session?.user) {
      router.push('/auth/signin');
    }
  }, [session, router]);

  // Query for fetching lists
  const {
    data: lists = [],
    isLoading: loading,
    refetch: fetchLists,
  } = useQuery({
    queryKey: ['lists'],
    queryFn: fetchListsAPI,
    enabled: !!session?.user,
  });

  // Mutation for creating list
  const createMutation = useMutation({
    mutationFn: createListAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lists'] });
    },
    onError: (error: Error) => {
      alert('Ошибка при создании списка');
    },
  });

  // Mutation for deleting list
  const deleteMutation = useMutation({
    mutationFn: deleteListAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lists'] });
    },
    onError: (error: Error) => {
      alert('Ошибка при удалении списка');
    },
  });

  const createList = async (name: string) => {
    if (!name.trim()) {
      alert('Введите название списка');
      return false;
    }

    try {
      await createMutation.mutateAsync(name);
      return true;
    } catch (error) {
      return false;
    }
  };

  const deleteList = async (listId: string, listName: string) => {
    if (!confirm(`Удалить список "${listName}"?`)) return;

    try {
      await deleteMutation.mutateAsync(listId);
    } catch (error) {
      console.error('Error deleting list:', error);
    }
  };

  return {
    lists,
    loading,
    createList,
    deleteList,
  };
}
