'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useLists } from '@/store/lists';

export type List = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;
  _count: {
    items: number;
  };
};

export const listsQueryKey = ['lists'] as const;

export const fetchListsAPI = async (): Promise<List[]> => {
  const response = await fetch('/api/lists');
  if (!response.ok) throw new Error('Failed to fetch lists');

  const data = await response.json();

  if (data.length === 0) {
    const initResponse = await fetch('/api/lists/init', {
      method: 'POST',
    });
    if (!initResponse.ok) throw new Error('Failed to initialize lists');
    return initResponse.json();
  }

  return data;
};

export function resolveActiveListId(lists: List[], selectedListId: string | null) {
  const selectedList = selectedListId ? lists.find((list) => list.id === selectedListId) : null;
  return selectedList?.id || lists.find((list) => list.isActive)?.id || lists[0]?.id || null;
}

export function useListsQuery() {
  const { data: session } = useSession();

  return useQuery({
    queryKey: listsQueryKey,
    queryFn: fetchListsAPI,
    enabled: !!session?.user,
  });
}

export function useActiveList() {
  const selectedListId = useLists((state) => state.activeListId);
  const query = useListsQuery();
  const lists = query.data || [];
  const activeListId = resolveActiveListId(lists, selectedListId);
  const activeList = activeListId ? lists.find((list) => list.id === activeListId) || null : null;

  return {
    ...query,
    lists,
    activeList,
    activeListId,
    loading: query.isLoading,
  };
}
