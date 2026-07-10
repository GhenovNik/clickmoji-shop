import { create } from 'zustand';

type ListsStore = {
  activeListId: string | null;
  setActiveList: (listId: string | null) => void;
  clearActiveList: () => void;
};

export const useLists = create<ListsStore>((set) => ({
  activeListId: null,

  setActiveList: (listId) => {
    set({ activeListId: listId });
  },

  clearActiveList: () => {
    set({ activeListId: null });
  },
}));
