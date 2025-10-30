import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ShoppingItem = {
  id: string;
  productId: string;
  name: string;
  emoji: string;
  categoryName: string;
  isPurchased: boolean;
  addedAt: Date;
};

export type CompletedList = {
  id: string;
  completedAt: Date;
  items: ShoppingItem[];
};

type ShoppingListStore = {
  items: ShoppingItem[];
  history: CompletedList[];
  addItems: (products: Omit<ShoppingItem, 'id' | 'isPurchased' | 'addedAt'>[]) => void;
  removeItem: (id: string) => void;
  togglePurchased: (id: string) => void;
  clearPurchased: () => void;
  clearAll: () => void;
  completeList: () => void;
  restoreFromHistory: (historyId: string) => void;
  deleteFromHistory: (historyId: string) => void;
};

export const useShoppingList = create<ShoppingListStore>()(
  persist(
    (set) => ({
      items: [],
      history: [],

      addItems: (products) =>
        set((state) => {
          const newItems = products
            .filter(
              (product) =>
                !state.items.some((item) => item.productId === product.productId)
            )
            .map((product) => ({
              ...product,
              id: `${product.productId}-${Date.now()}`,
              isPurchased: false,
              addedAt: new Date(),
            }));

          return {
            items: [...state.items, ...newItems],
          };
        }),

      removeItem: (id) =>
        set((state) => ({
          items: state.items.filter((item) => item.id !== id),
        })),

      togglePurchased: (id) =>
        set((state) => ({
          items: state.items.map((item) =>
            item.id === id ? { ...item, isPurchased: !item.isPurchased } : item
          ),
        })),

      clearPurchased: () =>
        set((state) => ({
          items: state.items.filter((item) => !item.isPurchased),
        })),

      clearAll: () => set({ items: [] }),

      completeList: () =>
        set((state) => {
          if (state.items.length === 0) return state;

          const completedList: CompletedList = {
            id: `list-${Date.now()}`,
            completedAt: new Date(),
            items: state.items,
          };

          return {
            items: [],
            history: [completedList, ...state.history].slice(0, 20), // Keep last 20 lists
          };
        }),

      restoreFromHistory: (historyId) =>
        set((state) => {
          const historyList = state.history.find((list) => list.id === historyId);
          if (!historyList) return state;

          // Reset isPurchased and regenerate IDs
          const restoredItems = historyList.items.map((item) => ({
            ...item,
            id: `${item.productId}-${Date.now()}-${Math.random()}`,
            isPurchased: false,
            addedAt: new Date(),
          }));

          return {
            items: restoredItems,
          };
        }),

      deleteFromHistory: (historyId) =>
        set((state) => ({
          history: state.history.filter((list) => list.id !== historyId),
        })),
    }),
    {
      name: 'shopping-list-storage',
    }
  )
);
