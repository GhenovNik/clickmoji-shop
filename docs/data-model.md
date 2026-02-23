# Data Model

Source of truth: `prisma/schema.prisma`.

## Models (summary)

### User

- `id`, `email`, `name`, `image`, `role`
- `password` is stored as a bcrypt hash (created in registration handler)
- `emailVerified` is nullable and used by verification-gated sign-in
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

- `name`, `nameEn`, `emoji`, `isCustom`, `imageUrl`
- Relations: `category`, `variants`, `items`, `favorites`

### ProductVariant

- `name`, `nameEn`, `emoji`
- Relation: `product`
- Used in admin product forms and product selection flows

### List

- `name`, `isActive`
- Relation: `user`, `items`, `histories`
- No database-level guarantee for “one active list” yet

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
- Planned: partial unique index for one active list per user

## Seed data

Seed lives in `prisma/seed.ts`. Current seed creates 17 categories and a large starter catalog.

## Planned changes

- Add partial unique index for one active list per user
- Optional: additional uniqueness for base items (when variants are absent)
