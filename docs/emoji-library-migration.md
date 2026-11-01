# Миграция: библиотека emoji (AGE-1465)

Миграция `prisma/migrations/20261101004533_add_emoji_library` только **добавляет**: таблицу
`emoji_library_items` с индексами и пустую колонку `products."imageUrlEn"` (английский вариант
картинки с надписями). Существующие данные не меняются. Откат —
`DROP TABLE "emoji_library_items"; ALTER TABLE "products" DROP COLUMN "imageUrlEn";`.

Применяет оператор, **до слияния и деплоя** этого PR. Код без миграции **несовместим** с базой:
Prisma запрашивает у товаров колонку `imageUrlEn`, и страницы с товарами упадут, пока её нет.
Поэтому порядок строгий: бэкап → миграция → проверка → слияние и деплой.

## Порядок

1. Бэкап и проверка, что он читается:

   ```bash
   DATABASE_URL='<прямой (unpooled) URL продовой БД>' npm run db:backup
   ```

   Убедиться, что в `backups/` появился свежий `clickmoji-*.dump` ненулевого размера.

2. Применить миграцию:

   ```bash
   DATABASE_URL='<прямой URL>' npx prisma migrate deploy
   ```

   Ожидается `Applying migration 20261101004533_add_emoji_library` и
   `All migrations have been successfully applied`.

3. Проверить:

   ```bash
   DATABASE_URL='<прямой URL>' npx prisma migrate status
   ```

   Ожидается `Database schema is up to date!`.

4. После деплоя: в админке открыть товар → «📚 Библиотека» — пустой список без ошибки; загрузить
   картинку товару → она появляется в библиотеке.

Проверено на локальном PostgreSQL 17 (контейнер `postgres:17-alpine`): все миграции с нуля, затем
эта, `migrate status` — актуально.
