# API Overview

All endpoints are implemented as Next.js Route Handlers under `src/app/api`.

## Conventions

- Authentication uses NextAuth with JWT sessions.
- Admin-only endpoints validate `session.user.role === "ADMIN"`.
- Errors are returned as `{ error: string }` with HTTP status codes.

## Auth

### `POST /api/auth/register`

- Auth: public
- Body: `email`, `password`, `name?`
- Response: `{ message, user: { id, email, name } }`
- Notes: hashes password, creates default lists

### `GET|POST /api/auth/[...nextauth]`

- Auth: public
- Notes: NextAuth handlers

## Users (admin)

### `GET /api/users`

- Auth: admin
- Response: list of users with counts and `completedSessions`

### `POST /api/users`

- Auth: admin
- Body: `email`, `password`, `name?`, `role?`
- Response: created user (no password)

### `PUT /api/users/:userId`

- Auth: admin
- Body: `email?`, `name?`, `password?`, `role?`, `image?`
- Notes: hashes password when provided

### `DELETE /api/users/:userId`

- Auth: admin
- Notes: prevents deleting own account

## Categories

### `GET /api/categories`

- Auth: public
- Response: categories with `_count.products`

### `POST /api/categories`

- Auth: admin
- Body: `name`, `nameEn`, `emoji?`, `order`, `isCustom?`, `imageUrl?`
- Notes: requires either `emoji` or `imageUrl`; shifts order when conflicts occur

### `PUT /api/categories/:categoryId`

- Auth: admin
- Body: `name?`, `nameEn?`, `emoji?`, `order?`, `isCustom?`, `imageUrl?`
- Notes: handles order swap; deletes old UploadThing image when replaced

### `DELETE /api/categories/:categoryId`

- Auth: admin
- Notes: cascades products, deletes UploadThing image if present

## Products

### `GET /api/products`

- Auth: public
- Query: `categoryId?`
- Response: products with `variants` and `category`

### `POST /api/products`

- Auth: admin
- Body: `name`, `nameEn`, `categoryId`, `emoji?`, `isCustom?`, `imageUrl?`
- Notes: `emoji` required when `isCustom` is false

### `PUT /api/products/:productId`

- Auth: admin
- Body: `name?`, `nameEn?`, `emoji?`, `categoryId?`, `isCustom?`, `imageUrl?`
- Notes: deletes old UploadThing image when replaced

### `DELETE /api/products/:productId`

- Auth: admin

### `POST /api/products/bulk-import`

- Auth: admin
- Body: `productNames: string[]`
- Notes: Gemini categorization + translation + emoji; skips duplicates

### `POST /api/products/smart-create`

- Auth: signed in
- Body: `productName`, `categoryId?`
- Notes: Gemini analysis; can call `/api/emoji/generate` + `/api/emoji/upload` internally

### `POST /api/products/move-category`

- Auth: admin
- Body: `productIds: string[]`, `newCategoryId`

## Lists

### `GET /api/lists`

- Auth: signed in
- Response: lists with `_count.items`

### `POST /api/lists`

- Auth: signed in
- Body: `name`, `isActive?`
- Notes: deactivates existing active list when `isActive` is true

### `POST /api/lists/init`

- Auth: signed in
- Notes: creates default lists if none exist

### `GET /api/lists/:listId`

- Auth: signed in
- Response: list with `items` and `product.category`

### `PUT /api/lists/:listId`

- Auth: signed in
- Body: `name?`, `isActive?`
- Notes: deactivates other lists when activating

### `DELETE /api/lists/:listId`

- Auth: signed in
- Notes: activates oldest remaining list when active list is deleted

### `POST /api/lists/:listId/items`

- Auth: signed in
- Body: `items: Array<{ productId, variantId?, note? }>`
- Notes: allows duplicates (different notes)

### `PUT /api/lists/:listId/items/:itemId`

- Auth: signed in
- Body: `isPurchased?`, `note?`
- Notes: sets or clears `purchasedAt`

### `DELETE /api/lists/:listId/items/:itemId`

- Auth: signed in

### `POST /api/lists/import-text`

- Auth: signed in
- Body: `text`, `listId`
- Notes: Gemini parses, creates missing products, adds items

## Favorites

### `GET /api/favorites`

- Auth: signed in
- Response: favorites ordered by `usageCount`

### `POST /api/favorites`

- Auth: signed in
- Body: `productId`
- Notes: upsert with `usageCount` increment

### `DELETE /api/favorites`

- Auth: signed in
- Query: `productId`

## Search

### `GET /api/search`

- Auth: public
- Query: `q`
- Notes: PostgreSQL `pg_trgm` similarity, returns top 10 matches

## Emoji

### `GET /api/emoji/search`

- Auth: public
- Query: `q`
- Response: `{ query, results, count }`

### `POST /api/emoji/generate`

- Auth: admin
- Body: `productName`
- Response: `{ base64, message }`
- Notes: provider selected by `AI_PROVIDER`

### `POST /api/emoji/upload`

- Auth: admin
- Body: `base64`, `productName?`
- Response: `{ imageUrl, fileName }`

### `DELETE /api/emoji/delete`

- Auth: admin
- Body: `imageUrl`

## UploadThing

### `GET|POST /api/uploadthing`

- Auth: handled by UploadThing router
