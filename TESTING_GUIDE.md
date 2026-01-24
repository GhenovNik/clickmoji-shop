# Руководство по тестированию и автоматизации проверки качества кода

## Быстрый старт

- Локально (до коммита): `npm run check`
- E2E: `npm run test:e2e` (Playwright поднимает Next.js через `webServer` в `playwright.config.ts`)
- Полный прогон как в CI: `npm run ci`

> Примечание: в Next.js App Router `async` Server Components плохо подходят для unit-тестов — критичные сценарии лучше закрывать E2E.

### Важные замечания по текущей конфигурации

- В Next.js `16.0.10` нет команды `next lint`, поэтому `npm run lint` использует `eslint .` напрямую.
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
npm run lint -- --fix     # Автоматическое исправление
```

#### TypeScript ✅

**Что проверяет:**

- Типизация данных
- Несуществующие свойства
- Неправильные типы параметров
- Null/undefined ошибки

**Использование:**

```bash
npx tsc --noEmit          # Проверка типов без компиляции
```

---

### 2. Инструменты для установки

#### A. Prettier - Форматирование кода

```bash
npm install --save-dev prettier eslint-config-prettier
```

**Создать `.prettierrc.json`:**

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "tabWidth": 2,
  "printWidth": 100
}
```

**Добавить в package.json:**

```json
{
  "scripts": {
    "format": "prettier --write \"src/**/*.{ts,tsx,js,jsx,json,css}\"",
    "format:check": "prettier --check \"src/**/*.{ts,tsx,js,jsx,json,css}\""
  }
}
```

#### B. Playwright - E2E тестирование (UI + интеграция)

```bash
npm install --save-dev @playwright/test
npx playwright install
```

**Рекомендуемо: настроить `baseURL` и автозапуск Next.js через `webServer`**

**Создать `playwright.config.ts`:**

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

**Создать `tests/shopping-list.spec.ts`:**

```typescript
import { test, expect } from '@playwright/test';

test.describe('Shopping List', () => {
  test('добавление товара через поиск', async ({ page }) => {
    await page.goto('/');

    // Лучше опираться на роли/aria или data-testid, а не на `text=`
    await page.getByTestId('product-search-input').fill('молоко');
    await page.getByTestId('product-search-result').filter({ hasText: 'Молоко' }).first().click();

    await expect(page.getByTestId('toast')).toContainText(/добавлен/i);
  });

  test('добавление товара через категории', async ({ page }) => {
    await page.goto('/categories');

    await page
      .getByTestId('category-card')
      .filter({ hasText: 'Молочные продукты' })
      .first()
      .click();
    await page.getByTestId('product-card').filter({ hasText: 'Молоко' }).first().click();
    await page.getByRole('button', { name: /добавить в список/i }).click();

    await expect(page).toHaveURL(/\/lists/);
    await expect(page.getByTestId('shopping-list')).toContainText(/молоко/i);
  });
});
```

> Если `data-testid` сейчас нет — стоит добавить их на ключевые элементы. Это делает E2E тесты стабильными при изменении текста/верстки.

**Добавить в `package.json`:**

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

**Создать `vitest.setup.ts`:**

```typescript
import '@testing-library/jest-dom/vitest';
```

**Создать `vitest.config.ts`:**

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Включено здесь, потому что в гайде ниже есть метрики coverage
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/types/'],
    },
  },
});
```

**Пример теста `src/store/__tests__/lists.test.ts`:**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useLists } from '../lists';

describe('Lists Store', () => {
  beforeEach(() => {
    useLists.setState({ lists: [], activeListId: null });
  });

  it('должен установить активный список', () => {
    const mockLists = [
      { id: '1', name: 'List 1', isActive: true, _count: { items: 0 } },
      { id: '2', name: 'List 2', isActive: false, _count: { items: 0 } },
    ];

    useLists.getState().setLists(mockLists);
    expect(useLists.getState().activeListId).toBe('1');
  });
});
```

**Добавить в `package.json`:**

```json
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "test:ui": "vitest --ui",
    "typecheck": "tsc --noEmit",
    "check": "npm run lint && npm run typecheck && npm run test:run",
    "ci": "npm run check && npm run build && npm run test:e2e"
  }
}
```

> Практика для Next.js App Router: unit-тестами закрываем store/утилиты/Client Components; `async` Server Components — через E2E.

#### D. Lighthouse CI - Проверка производительности и доступности

```bash
npm install --save-dev @lhci/cli
```

**Создать `lighthouserc.json`:**

```json
{
  "ci": {
    "collect": {
      "startServerCommand": "npm run start",
      "url": ["http://localhost:3000", "http://localhost:3000/categories"],
      "numberOfRuns": 3
    },
    "assert": {
      "assertions": {
        "categories:performance": ["warn", { "minScore": 0.8 }],
        "categories:accessibility": ["error", { "minScore": 0.9 }],
        "categories:best-practices": ["warn", { "minScore": 0.8 }],
        "categories:seo": ["warn", { "minScore": 0.8 }]
      }
    }
  }
}
```

**Добавить в `package.json`:**

```json
{
  "scripts": {
    "lighthouse": "lhci autorun --config=./lighthouserc.json"
  }
}
```

#### E. Axe DevTools - Accessibility тестирование

```bash
npm install --save-dev @axe-core/playwright
```

**Пример использования:**

```typescript
import { test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('проверка доступности главной страницы', async ({ page }) => {
  await page.goto('http://localhost:3000');

  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

  expect(accessibilityScanResults.violations).toEqual([]);
});
```

#### F. Madge - Анализ зависимостей и циклических импортов

```bash
npm install --save-dev madge
```

**Добавить в package.json:**

```json
{
  "scripts": {
    "analyze:deps": "madge --circular --extensions ts,tsx src/",
    "analyze:graph": "madge --image deps-graph.svg --extensions ts,tsx src/"
  }
}
```

---

### 3. Pre-commit hooks (Husky + lint-staged)

**Автоматическая проверка перед коммитом:**

```bash
npm install --save-dev husky lint-staged
npx husky init
```

**Создать `.husky/pre-commit`:**

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx lint-staged
```

**Добавить в package.json:**

```json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write", "vitest related --run"],
    "*.{json,md}": ["prettier --write"]
  }
}
```

---

### 4. GitHub Actions CI/CD

**Создать `.github/workflows/test.yml`:**

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    # Если тесты ходят в БД (Prisma/Postgres), поднимай сервис здесь
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: app_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd="pg_isready -U postgres"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5

    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/app_test
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: test-secret
      # Чтобы Playwright request() мог использовать относительные URL
      PLAYWRIGHT_BASE_URL: http://localhost:3000

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Lint
        run: npm run lint

      - name: Type check
        run: npm run typecheck

      - name: Unit tests
        run: npm run test:run

      - name: Build
        run: npm run build

      - name: DB migrations (if Prisma)
        run: npx prisma migrate deploy

      - name: E2E tests
        run: npm run test:e2e
```

### 5. Recommended VS Code Extensions

**Создать `.vscode/extensions.json`:**

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
# 1. Запуск линтера
npm run lint

# 2. Проверка типов
npx tsc --noEmit

# 3. Запуск unit тестов
npm test

# 4. Форматирование кода
npm run format
```

### Перед коммитом:

```bash
# Автоматически через husky
git commit -m "feat: add new feature"
```

### Перед деплоем:

```bash
# 1. Все тесты
npm run lint
npm test
npm run test:e2e

# 2. Билд
npm run build

# 3. Проверка производительности
npm run lighthouse
```

---

## Метрики качества кода

### Code Coverage (Vitest)

```bash
npm run test:run -- --coverage
```

> Coverage требует `@vitest/coverage-v8` (добавлено в раздел установки Vitest).

**Пример настройки (уже включено в `vitest.config.ts` выше):**

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/types/'],
    },
  },
});
```

### Целевые метрики:

- **Coverage**: >80% для критичных модулей
- **ESLint**: 0 ошибок
- **TypeScript**: 0 ошибок
- **Lighthouse Performance**: >80
- **Lighthouse Accessibility**: >90

---

## Конкретные проверки для вашего проекта

### Проверка API endpoints:

```typescript
// tests/api/lists.spec.ts
import { test, expect } from '@playwright/test';

test.describe('API /api/lists', () => {
  test('должен создать список', async ({ request }) => {
    const response = await request.post('/api/lists', {
      data: { name: 'Test List' },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('id');
  });
});
```

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

## Рекомендации по приоритетам

### Немедленно (высокий приоритет):

1. ✅ ESLint + TypeScript (уже есть)
2. Playwright для E2E тестов (находит проблемы как с ProductSearch)
3. Prettier для форматирования
4. Husky для pre-commit hooks

### Средний приоритет:

1. Vitest для unit тестов
2. Lighthouse CI для производительности
3. GitHub Actions CI/CD

### Низкий приоритет:

1. Axe для accessibility
2. Madge для анализа зависимостей
3. Visual regression testing (Percy, Chromatic)

---

## Команда быстрого старта

```bash
# Установка основных инструментов
npm install --save-dev \
  prettier eslint-config-prettier \
  @playwright/test \
  husky lint-staged \
  vitest @vitejs/plugin-react jsdom \
  @testing-library/react @testing-library/dom @testing-library/jest-dom \
  vite-tsconfig-paths @vitest/coverage-v8

# Настройка
npx husky init
npx playwright install

# Скрипты (пример)
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.test:run="vitest run"
npm pkg set scripts.check="npm run lint && npm run typecheck && npm run test:run"
npm pkg set scripts.test:e2e="playwright test"
npm pkg set scripts.ci="npm run check && npm run build && npm run test:e2e"

# Создать .prettierrc.json
echo '{"semi":true,"singleQuote":true,"tabWidth":2}' > .prettierrc.json
```

> Для E2E добавь `playwright.config.ts` (см. раздел Playwright) и, по возможности, `data-testid` в критических местах UI.

## Дополнительные ресурсы

- [Next.js Testing Guide](https://nextjs.org/docs/testing)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [React Testing Library](https://testing-library.com/react)
- [TypeScript Strict Mode](https://www.typescriptlang.org/tsconfig#strict)
