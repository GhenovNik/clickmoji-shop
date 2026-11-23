'use client';

import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { listsQueryKey, useListsQuery } from './useListsQuery';

export type { List } from './useListsQuery';

// API functions
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
  const { status } = useSession();
  const queryClient = useQueryClient();
  const t = useTranslations('lists');

  // Redirect only a confirmed unauthenticated visitor (must be in useEffect for SSR)
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
    }
  }, [status, router]);

  // Query for fetching lists
  const { data: lists = [], isLoading: loading } = useListsQuery();

  // Mutation for creating list
  const createMutation = useMutation({
    mutationFn: createListAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listsQueryKey });
    },
    onError: (error: Error) => {
      alert(t('listsManagement.createFailed'));
    },
  });

  // Mutation for deleting list
  const deleteMutation = useMutation({
    mutationFn: deleteListAPI,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listsQueryKey });
    },
    onError: (error: Error) => {
      alert(t('listsManagement.deleteFailed'));
    },
  });

  const createList = async (name: string) => {
    if (!name.trim()) {
      alert(t('listsManagement.nameRequired'));
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
    if (!confirm(t('listsManagement.deleteConfirm', { listName }))) return;

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
