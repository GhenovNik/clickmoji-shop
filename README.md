# Clickmoji Shop

Emoji-first shopping list с AI-помощником для управления товарами. README оставлен коротким, подробные спецификации и план — в `/docs`.

## Статус

- Стадия: активная разработка
- Версия: 0.1.x
- Последнее обновление: январь 2026

## Что уже реализовано

- Credentials-аутентификация с ролями (NextAuth + JWT)
- Категории, товары и выбор через emoji-сетку
- Поиск с автодополнением
- Избранное с учетом частоты использования
- Несколько списков, заметки к товарам, отметка покупок, импорт из текста
- Экран истории (client-side состояние)
- Админ-панель: пользователи, категории, товары
- AI: генерация emoji, bulk-import, smart-create
- UploadThing для кастомных изображений

## Ближайшие улучшения

- Усиление auth: валидация, сброс пароля, email verification
- OAuth (Google)
- RBAC для admin API
- PWA и офлайн-режим
- Разновидности товаров

## Быстрый старт

### Требования

- Node.js 18+
- PostgreSQL 14+

### Установка

```bash
npm install
cp .env.example .env
npx prisma migrate dev
npx prisma db seed
npm run dev
```

### Переменные окружения

```env
DATABASE_URL="postgresql://user:password@localhost:5432/clickmoji_shop"
NEXTAUTH_SECRET="your-secret-key"
NEXTAUTH_URL="http://localhost:3000"
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
RESEND_API_KEY="your-resend-api-key"
RESEND_FROM_EMAIL="no-reply@clickmoji.shop"
UPLOADTHING_TOKEN="your-uploadthing-token"
GOOGLE_GENAI_API_KEY="your-google-api-key"
OPENAI_API_KEY="your-openai-api-key"
AI_PROVIDER="gemini"
```

## Документация

- `docs/architecture.md`
- `docs/data-model.md`
- `docs/api.md`
- `docs/roadmap.md`
- `docs/ai.md`
- `docs/ux-flows.md`
- `docs/ops.md`

## Полезные команды

```bash
npm run dev
npm run build
npm run lint
npm run typecheck
npm run test
npm run test:e2e
```
