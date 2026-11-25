// The legacy English picture columns (`products.imageUrlEn`, `product_variants.imageUrlEn`,
// `list_history_items.productImageUrlEn`) stay in the database until AGE-1667 Ya6 drops them, as
// a write-only rollback mirror. A query that serves a row to a client or to the app omits them, so
// the old column never leaves the database: display reads the picture dictionary only. A
// compatibility key of an exported file is computed from the dictionary (`src/lib/account.ts`),
// never taken from the column.
//
// Pass these as `omit` next to an `include` (a query with an explicit `select` already names
// every field it returns and needs none).
export const PRODUCT_OMIT = { imageUrlEn: true } as const;
export const VARIANT_OMIT = { imageUrlEn: true } as const;
export const HISTORY_ITEM_OMIT = { productImageUrlEn: true } as const;
