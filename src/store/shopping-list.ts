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

type ShoppingListStore = {
  items: ShoppingItem[];
  addItems: (products: Omit<ShoppingItem, 'id' | 'isPurchased' | 'addedAt'>[]) => void;
  removeItem: (id: string) => void;
  togglePurchased: (id: string) => void;
  clearPurchased: () => void;
  clearAll: () => void;
};

export const useShoppingList = create<ShoppingListStore>()(
  persist(
    (set) => ({
      items: [],

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
    }),
    {
      name: 'shopping-list-storage',
    }
  )
);
