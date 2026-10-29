// React Query keys for server state, in one place so that a mutation and the queries it changes
// cannot drift apart. Prefix keys (`products()`, `search()`) match every query below them.
export const queryKeys = {
  lists: () => ['lists'] as const,
  list: (listId: string) => ['list', listId] as const,
  history: () => ['history'] as const,
  favorites: () => ['favorites'] as const,
  categories: () => ['categories'] as const,
  products: () => ['products'] as const,
  categoryProducts: (categoryId: string) => ['products', categoryId] as const,
  search: () => ['search'] as const,
  searchQuery: (query: string) => ['search', query] as const,
};

type QueryKey = readonly unknown[];

// Operation -> server entities it changes. A mutation invalidates exactly these keys.
export const changedBy = {
  // New items in the list and new item counts; products the import created appear in the catalog,
  // search results and category counts.
  importText: (listId: string, createdProducts: boolean): QueryKey[] => [
    queryKeys.list(listId),
    queryKeys.lists(),
    ...(createdProducts ? [queryKeys.products(), queryKeys.search(), queryKeys.categories()] : []),
  ],
  // The list is emptied (items and count) and a new history entry exists.
  completeList: (listId: string): QueryKey[] => [
    queryKeys.list(listId),
    queryKeys.lists(),
    queryKeys.history(),
  ],
  // A new list exists; the history entry itself is unchanged.
  restoreHistory: (): QueryKey[] => [queryKeys.lists()],
};
