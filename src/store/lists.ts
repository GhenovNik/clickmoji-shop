import { create } from 'zustand';

export type List = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count: {
    items: number;
  };
};

type ListsStore = {
  lists: List[];
  activeListId: string | null;
  setLists: (lists: List[]) => void;
  setActiveList: (listId: string) => void;
  getActiveList: () => List | null;
};

export const useLists = create<ListsStore>((set, get) => ({
  lists: [],
  activeListId: null,

  setLists: (lists) => {
    const activeList = lists.find((list) => list.isActive);
    set({
      lists,
      activeListId: activeList?.id || lists[0]?.id || null,
    });
  },

  setActiveList: (listId) => {
    set({ activeListId: listId });
  },

  getActiveList: () => {
    const { lists, activeListId } = get();
    return lists.find((list) => list.id === activeListId) || null;
  },
}));
