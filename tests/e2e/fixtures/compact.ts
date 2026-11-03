import type { E2EShoppingItem } from './auth';

export const COMPACT_NOTE =
  'Взять свежую охлаждённую говядину для ужина, проверить срок годности и целостность упаковки.\n' +
  'Если нужного отруба нет, выбрать другой без маринада. Обязательно сохранить чек.\n' +
  'ОченьДлинноеСловоБезПробелов'.repeat(8);

export const compactGroups = [
  {
    name: /^🥬 Овощи \(3\)/,
    category: { name: 'Овощи', nameEn: 'Vegetables', emoji: '🥬', order: 1 },
    products: [
      { id: 'compact-tomato', name: 'Помидор', nameEn: 'Tomato', emoji: '🍅' },
      { id: 'compact-onion', name: 'Лук', nameEn: 'Onion', emoji: '🧅' },
      { id: 'compact-avocado', name: 'Авокадо', nameEn: 'Avocado', emoji: '🥑' },
    ],
  },
  {
    name: /^🍎 Фрукты \(1\)/,
    category: { name: 'Фрукты', nameEn: 'Fruit', emoji: '🍎', order: 2 },
    products: [{ id: 'compact-banana', name: 'Банан', nameEn: 'Banana', emoji: '🍌' }],
  },
  {
    name: /^🥩 Мясо \(3\)/,
    category: { name: 'Мясо', nameEn: 'Meat', emoji: '🥩', order: 3 },
    products: [
      { id: 'compact-pork', name: 'Свинина', nameEn: 'Pork', emoji: '🐖' },
      { id: 'compact-beef', name: 'Говядина', nameEn: 'Beef', emoji: '🐄' },
      { id: 'compact-chicken', name: 'Курица', nameEn: 'Chicken', emoji: '🐔' },
    ],
  },
];

export const compactPendingIds = compactGroups.flatMap((group) =>
  group.products.map((product) => product.id)
);
export const compactPurchasedId = 'compact-peas';
export const compactAllIds = [...compactPendingIds, compactPurchasedId];

// Fresh objects per test: the shared authenticated fixture mutates PUT/DELETE state.
export function createCompactItems(): E2EShoppingItem[] {
  const pending = compactGroups.flatMap((group) =>
    group.products.map((product) => ({
      id: product.id,
      isPurchased: false,
      note: product.id === 'compact-beef' ? COMPACT_NOTE : null,
      variant: null,
      product: {
        ...product,
        id: `product-${product.id}`,
        isCustom: false,
        imageUrl: null,
        category: { ...group.category },
      },
    }))
  );
  return [
    ...pending,
    {
      id: compactPurchasedId,
      isPurchased: true,
      note: COMPACT_NOTE,
      variant: null,
      product: {
        id: 'product-compact-peas',
        name: 'Горошек',
        emoji: '🫛',
        isCustom: false,
        imageUrl: null,
        category: { ...compactGroups[0].category },
      },
    },
  ];
}
