# Руководство по тестированию и автоматизации проверки качества кода

## Быстрый старт

- Локально (до коммита): `npm run check`
- E2E: `npm run test:e2e` (Playwright поднимает Next.js через `webServer` в `playwright.config.ts`)
- Полный прогон (эмуляция CI): `npm run check && npm run build && npm run test:e2e`

> Примечание: в Next.js App Router `async` Server Components плохо подходят для unit-тестов — критичные сценарии лучше закрывать E2E.

### Важные замечания по текущей конфигурации

- В проекте используется Next.js 16 и прямая команда `eslint .`
- UI E2E сценарии в `tests/e2e/public-categories.spec.ts` и `tests/e2e/shopping-list.spec.ts` временно отключены — нужен стабильный seed и auth flow для тестов.

## Исправленные проблемы (2025-12-25)

### ✅ Критические исправления:

1. **ProductSearch - использование устаревшего хранилища**
   - Файл: `src/components/ProductSearch.tsx`
   - Проблема: Использовал localStorage вместо серверного API
   - Исправление: Переключено на `/api/lists/[listId]/items` API

2. **Emoji подбор - слишком много результатов**
   - Файл: `src/app/api/emoji/search/route.ts:47`
   - Проблема: Возвращал 30 нерелевантных результатов
   - Исправление: Ограничено до 5 наиболее релевантных

3. **Автоскролл при редактировании**
   - Файлы: `src/app/admin/products/page.tsx`, `src/app/admin/categories/page.tsx`
   - Проблема: Форма открывалась вверху, пользователь не видел
   - Исправление: Добавлен автоматический скролл к форме и обратно к элементу

4. **Мобильная адаптация форм**
   - Файлы: админ панель продуктов и категорий
   - Проблема: Поля ввода и кнопки выходили за пределы экрана
   - Исправление: Улучшена grid-разметка и overflow-контроль

---

## Инструменты для автоматического обнаружения ошибок

### 1. Статический анализ кода (уже установлено)

#### ESLint ✅

**Что проверяет:**

- Синтаксические ошибки
- Неиспользуемые переменные
- Потенциальные баги (missing dependencies в useEffect)
- React хуки правила
- TypeScript строгость

**Использование:**

```bash
npm run lint              # Проверка всех файлов
npm run lint:fix          # Автоматическое исправление
```

#### TypeScript ✅

**Что проверяет:**

- Типизация данных
- Несуществующие свойства
- Неправильные типы параметров
- Null/undefined ошибки

**Использование:**

```bash
npm run typecheck         # Проверка типов без компиляции
```

---

### 2. Инструменты для установки (Историческая справка)

_Этот раздел описывает процесс первоначальной настройки проекта, большинство инструментов уже установлено._

#### A. Prettier - Форматирование кода

```bash
npm install --save-dev prettier eslint-config-prettier
```

**Создан `.prettierrc.json`:**

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "tabWidth": 2,
  "printWidth": 100
}
```

**Добавлено в package.json:**

```json
{
  "scripts": {
    "format": "prettier --write \"src/**/*.{ts,tsx,js,jsx,json,css}\""
  }
}
```

#### B. Playwright - E2E тестирование (UI + интеграция)

```bash
npm install --save-dev @playwright/test
npx playwright install
```

**Рекомендуемо: настроить `baseURL` и автозапуск Next.js через `webServer`**

**Создан `playwright.config.ts`:**

```typescript
import { defineConfig } from '@playwright/test';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    // Используем production server для консистентности
    command: 'npm run build && npm run start',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
```

**Добавлено в `package.json`:**

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

#### C. Vitest + React Testing Library - Unit/Component тестирование

```bash
npm install --save-dev \
  vitest @vitejs/plugin-react jsdom \
  @testing-library/react @testing-library/dom @testing-library/jest-dom \
  vite-tsconfig-paths @vitest/coverage-v8
```

**Добавлено в `package.json`:**

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm run lint && npm run test"
  }
}
```

#### D. Lighthouse CI - Проверка производительности и доступности (Отложено)

#### E. Axe DevTools - Accessibility тестирование (Отложено)

#### F. Madge - Анализ зависимостей и циклических импортов (Отложено)

---

### 3. Pre-commit hooks (Husky + lint-staged)

**Автоматическая проверка перед коммитом:**

Создан `.husky/pre-commit` вызывающий `npx lint-staged`.

**В package.json настроен автоматический prettier & eslint для новых файлов:**

```json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md,css}": ["prettier --write"]
  }
}
```

---

### 4. GitHub Actions CI/CD

В проекте используется `.github/workflows/ci.yml` который запускает команды `npm run check` и `npm run build` автоматически при пуше.

### 5. Recommended VS Code Extensions

**Создать `.vscode/extensions.json` (рекомендовано):**

```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "bradlc.vscode-tailwindcss",
    "prisma.prisma",
    "ms-playwright.playwright"
  ]
}
```

---

## Стандартные процессы разработки

### Ежедневная разработка:

```bash
# 1. Запуск комплексной проверки
npm run check

# 2. Форматирование кода (если редактор не настроен на автоформат)
npm run format
```

### Перед коммитом:

```bash
# Автоматически через husky (lint-staged)
git commit -m "feat: add new feature"
```

### Перед деплоем:

```bash
# 1. Все тесты и проверки (встроено в CI)
npm run check
npm run test:e2e

# 2. Билд
npm run build
```

---

## Метрики качества кода

### Code Coverage (Vitest)

```bash
npm run test:coverage
```

### Целевые метрики:

- **Coverage**: >80% для критичных модулей
- **ESLint**: 0 ошибок
- **TypeScript**: 0 ошибок

---

## Конкретные проверки для вашего проекта

### Проверка Zustand stores:

```typescript
// tests/stores/shopping-list.test.ts
import { useShoppingList } from '@/store/shopping-list';

test('должен добавить товар без дубликатов', () => {
  const store = useShoppingList.getState();

  store.addItems([{ productId: '1', name: 'Milk', emoji: '🥛', categoryName: 'Dairy' }]);
  store.addItems([{ productId: '1', name: 'Milk', emoji: '🥛', categoryName: 'Dairy' }]);

  expect(store.items).toHaveLength(1);
});
```

---

## Рекомендации по приоритетам на будущее

### Средний приоритет:

1. Запуск Lighthouse CI для производительности в рамках CI/CD

### Низкий приоритет:

1. Axe для accessibility
2. Madge для анализа зависимостей
3. Visual regression testing (Percy, Chromatic)
