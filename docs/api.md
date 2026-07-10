# API Overview

All endpoints are implemented as Next.js Route Handlers under `src/app/api`.

## Conventions

- Authentication uses NextAuth with JWT sessions.
- Admin-only endpoints validate `session.user.role === "ADMIN"`.
- Errors are returned as `{ error: string }` with HTTP status codes.
- Public catalog browsing is allowed for anonymous users through `/categories` and
  `/categories/:categoryId/products`; user-specific actions such as lists, favorites, history,
  custom products, imports, and AI creation still require authentication.

## Auth

### `POST /api/auth/register`

- Auth: public
- Body: `email`, `password`, `name?`
- Response: `{ message, emailSent, requiresEmailVerification, user }`
- Notes: validates password, applies rate limits, hashes password, creates default lists

### `GET|POST /api/auth/[...nextauth]`

- Auth: public
- Notes: NextAuth handlers

### `POST /api/auth/forgot-password`

- Auth: public
- Body: `email`
- Response: generic success message to avoid account enumeration
- Notes: uses IP/email rate limits

### `POST /api/auth/reset-password`

- Auth: public
- Body: `email`, `token`, `password`
- Response: `{ message }`
- Notes: validates password and consumes one-time reset token

### `GET /api/auth/verify`

- Auth: public
- Query: `email`, `token`
- Notes: consumes email verification token and redirects to `/login?verified=...`

### `POST /api/auth/resend`

- Auth: public
- Body: `email`
- Response: generic or success message
- Notes: only active when email verification is required; uses IP/email rate limits

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
- Body: `name`, `nameEn`, `categoryId`, `emoji?`, `isCustom?`, `imageUrl?`, `variants?`
- Notes: `emoji` required when `isCustom` is false; can create variants in same request

### `PUT /api/products/:productId`

- Auth: admin
- Body: `name?`, `nameEn?`, `emoji?`, `categoryId?`, `isCustom?`, `imageUrl?`, `variants?`
- Notes: upserts/deletes variants; keeps variants that are already used in items; deletes old UploadThing image when replaced

### `DELETE /api/products/:productId`

- Auth: admin

### `POST /api/products/bulk-import`

- Auth: admin
- Body: `productNames: string[]`
- Notes: Gemini categorization + translation + emoji; skips duplicates; rate limited to 10 requests/hour per admin user; response includes `promptVersion` and `model`

### `POST /api/products/smart-create`

- Auth: signed in
- Body: `productName`, `categoryId?`
- Notes: Gemini analysis through the AI product service; rate limited to 20 requests/hour per user; non-admin users are limited by `User.createdProductsCount` and create user-scoped products, while admins create global products. If a custom image is needed, the route calls the emoji asset service directly and does not self-call `/api/emoji/generate` or `/api/emoji/upload`. Response includes `promptVersion` and `model`.

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
- Notes: Gemini parses, creates missing products, adds items; rate limited to 10 requests/hour per user; response includes `promptVersion` and `model`

## History

### `GET /api/history`

- Auth: signed in
- Response: recent list completion snapshots with items

### `POST /api/history`

- Auth: signed in
- Body: `listId`
- Notes: snapshots list items into history and clears items from the source list

### `DELETE /api/history/:historyId`

- Auth: signed in
- Notes: deletes a history entry owned by current user

### `POST /api/history/:historyId/restore`

- Auth: signed in
- Body: `name?`
- Response: `{ listId, createdCount, skippedCount }`
- Notes: restores history snapshot into a new list and skips missing/invalid product references

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
- Response: `{ base64, message, provider, model, promptVersion, cacheKey }`
- Notes: provider selected by `AI_PROVIDER`; rate limited to 20 requests/hour per admin user

### `POST /api/emoji/upload`

- Auth: admin
- Body: `base64`, `productName?`
- Response: `{ imageUrl, fileName }`
- Notes: rate limited to 40 requests/hour per admin user

### `DELETE /api/emoji/delete`

- Auth: admin
- Body: `imageUrl`

## UploadThing

### `GET|POST /api/uploadthing`

- Auth: admin for the `productImage` uploader
- Limits: one image per request, maximum 2 MB
- Notes: the unused avatar uploader was removed; product and category images share the
  administrator-only uploader
