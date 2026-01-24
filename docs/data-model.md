# Data Model

Source of truth: `prisma/schema.prisma`.

## Models (summary)

### User

- `id`, `email`, `name`, `image`, `role`
- `password` is stored as a bcrypt hash (created in registration handler)
- Relations: `lists`, `favorites`

### Category

- `name`, `nameEn`, `emoji`, `isCustom`, `imageUrl`, `order`
- Relations: `products`

### Product

- `name`, `nameEn`, `emoji`, `isCustom`, `imageUrl`
- Relations: `category`, `variants`, `items`, `favorites`

### ProductVariant

- `name`, `nameEn`, `emoji`
- Relation: `product`
- Present in schema but not in UI yet

### List

- `name`, `isActive`
- Relation: `user`, `items`
- No database-level guarantee for “one active list” yet

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
- Optional: additional uniqueness for base items (when variants are introduced)
