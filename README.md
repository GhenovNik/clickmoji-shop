# Clickmoji Shop

Emoji-first shopping list с AI-помощником для управления товарами. README содержит краткую выжимку, подробные спецификации и план — в `/docs`.

## Статус

- Стадия: активная разработка
- Версия: 0.1.0
- Последнее обновление: Февраль 2026

## Что уже реализовано

- **Аутентификация (NextAuth v4)**: Credentials (с подтверждением по Email и сбросом пароля) и Google OAuth.
- **Интерфейс**: Категории, товары и выбор через emoji-сетку. Поиск с автодополнением.
- **Списки**: Несколько списков, заметки к товарам, отметка покупок, импорт списков из текста.
- **Персонализация**: Избранное с учетом частоты использования, история покупок.
- **Админ-панель**: Управление пользователями, категориями и товарами (RBAC).
- **AI-интеграция**: Генерация кастомных emoji (Gemini/OpenAI), bulk-import списков, smart-create товаров.
- **Медиа**: UploadThing для загрузки кастомных изображений и аватарок.

## Ближайшие улучшения

- PWA (Progressive Web App) и офлайн-режим.
- Разновидности товаров (объемы, бренды, цвета).
- Групповые списки (шаринг с семьей).

## Быстрый старт

### Требования

- Node.js 22+
- PostgreSQL 14+

### Установка

```bash
npm install
cp .env.example .env
# Отредактируйте .env, добавив ключи к БД и нужным API
npx prisma db push # или npx prisma migrate dev
npx prisma db seed
npm run dev
```

### Основные переменные окружения (.env)

```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/clickmoji_shop"

# NextAuth v4
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-super-secret-key"

# Google OAuth (опционально)
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"

# Resend (отправка писем)
RESEND_API_KEY="your-resend-api-key"
RESEND_FROM_EMAIL="no-reply@clickmoji.shop"

# UploadThing (загрузка файлов)
UPLOADTHING_TOKEN="your-uploadthing-token"

# AI (опционально, можно выбрать один)
AI_PROVIDER="gemini" # или openai
GOOGLE_GENAI_API_KEY="your-google-api-key"
OPENAI_API_KEY="your-openai-api-key"
```

## Документация

- `docs/architecture.md` — архитектура и стек
- `docs/data-model.md` — схема БД
- `docs/api.md` — описание API
- `docs/roadmap.md` — планы развития
- `docs/ai.md` — ИИ интеграция
- `docs/ux-flows.md` — пользовательский опыт
- `docs/ops.md` — деплой и эксплуатация

## Полезные команды

```bash
npm run dev          # Запуск локального сервера разработки
npm run build        # Сборка проекта для продакшена
npm run check        # Запуск проверок (Typecheck + Lint + Unit тесты)
npm run lint         # Проверка линтером
npm run test:watch   # Запуск Unit-тестов в режиме наблюдения
npm run test:e2e     # Запуск End-to-End тестов Playwright
```

## DB Scripts (Утилиты для базы данных)

В директории `scripts/` находятся полезные скрипты для администрирования БД. Запускать через `tsx`:

- Пользователи: `npx tsx scripts/db-users.ts --help` (создание админа, подтверждение email)
- Продукты: `npx tsx scripts/db-products.ts --help` (перенос продуктов между категориями)
- Категории: `npx tsx scripts/db-categories.ts --help`
- Списки: `npx tsx scripts/db-lists.ts --help` (поиск и удаление дубликатов)
- Файлы: `npx tsx scripts/db-files.ts --help` (очистка орфанных файлов UploadThing)
- Перенос данных: `npx tsx scripts/db-transfer.ts --help`
