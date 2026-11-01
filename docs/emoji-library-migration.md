# Миграция: библиотека emoji (AGE-1465)

Миграция `prisma/migrations/20261101001719_add_emoji_library` только **добавляет** таблицу
`emoji_library_items` и три индекса. Существующие таблицы и данные не меняются, откат —
`DROP TABLE "emoji_library_items";`.

Применяет оператор, **до слияния и деплоя** этого PR: код записывает в таблицу и спрашивает её
перед удалением файлов. Если таблицы нет, приложение не ломается — загрузка проходит, запись в
библиотеку пропускается с ошибкой в логе, а файлы картинок не удаляются; `npm run db:files`
падает, ничего не удалив.

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

   Ожидается `Applying migration 20261101001719_add_emoji_library` и
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
