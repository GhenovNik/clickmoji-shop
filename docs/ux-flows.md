# UX Flows

## First-time user

1. Landing page
2. Open the public catalog from `Каталог товаров`
3. Browse categories and products without signing in
4. Register or sign in when adding products to a list, using favorites, history, import, or AI creation
5. Default lists are created automatically after registration

## Add items

1. Sign in
2. Open categories
3. Select products from emoji grid
4. Add to list

## Public catalog browsing

1. Open the landing page
2. Tap `Каталог товаров`
3. Browse categories and product cards without a login redirect
4. Selecting a product shows a sign-in call to action before list mutation

## Search and quick add

1. Sign in
2. Open a non-empty list
3. Enter search term
4. Select suggestion
5. Item is added to the current active list and the list query is refreshed

## Shopping mode

1. Sign in
2. Open list in store
3. Toggle purchased state
4. Optional notes per item

## Favorites

1. Sign in
2. Open favorites
3. Tap to add to list
4. Remove from favorites if needed

## Import from text

1. Sign in
2. Open import modal
3. Paste list text
4. AI maps products, creates missing products if needed, and adds items

## E2E smoke contract

1. Public catalog can be browsed without signing in
2. Add-to-list from public catalog shows a sign-in call to action
3. Authenticated smoke fixture can add products from search and category grid without local Postgres

## Admin: add product

1. Open admin panel
2. Create or edit a product
3. Optionally generate/upload emoji
