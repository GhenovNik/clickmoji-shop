# Data Model

Source of truth: `prisma/schema.prisma`.

## Models (summary)

### User

- `id`, `email`, `name`, `image`, `role`
- `password` is stored as a bcrypt hash (created in registration handler)
- `emailVerified` is nullable and used by verification-gated sign-in
- `createdProductsCount` tracks non-admin smart-created custom products
- Relations: `lists`, `favorites`, `histories`

### EmailVerificationToken

- `email`, `token`, `expiresAt`
- Used by `/api/auth/register`, `/api/auth/verify`, `/api/auth/resend`

### PasswordResetToken

- `email`, `token`, `expiresAt`
- Used by `/api/auth/forgot-password` and `/api/auth/reset-password`

### Category

- `name`, `nameEn`, `emoji`, `isCustom`, `imageUrl`, `order`
- Relations: `products`

### Product

- `name`, `nameEn`, `emoji`, `isCustom`, `imageUrl`, `isGlobal`, `createdById`
- Relations: `category`, `variants`, `items`, `favorites`
- Admin-created products are global; signed-in user smart-created products are scoped through
  `createdById`

### ProductVariant

- `name`, `nameEn`, `emoji`
- Relation: `product`
- Used in admin product forms and product selection flows

### List

- `name`, `isActive`
- Relation: `user`, `items`, `histories`
- At most one active list per user is enforced by the raw SQL partial unique index
  `lists_one_active_per_user_idx`

### ListHistory

- `listName`, `completedAt`
- Relations: `user`, optional `list`, `items`
- Stores snapshots of completed shopping lists

### ListHistoryItem

- Snapshot fields for product/category/variant/name/emoji/image
- Keeps historical data even when source products change later
- Relation: `history`

### Item

- `isPurchased`, `note`, `purchasedAt`
- Relation: `list`, `product`, optional `variant`
- Duplicates are allowed to support different notes per item

### Favorite

- `usageCount`
- Unique per `userId + productId`

## Indexes and constraints

- Indexed: `categoryId`, `name`, `listId`, `productId`, `userId`
- Unique: `email` on `User`, `userId + productId` on `Favorite`
- Partial unique index: `lists_one_active_per_user_idx` on `List.userId`
  where `isActive = true`

## Seed data

Seed lives in `prisma/seed.ts`. Current seed creates 17 categories and a large starter catalog.

## Migration checks

Before deploying `20260627000000_unique_active_list_per_user`, this query should
return no rows after the migration cleanup has run:

```sql
SELECT "userId", COUNT(*) AS active_count
FROM "lists"
WHERE "isActive" = true
GROUP BY "userId"
HAVING COUNT(*) > 1;
```

## Planned changes

- Optional: additional uniqueness for base items (when variants are absent)
