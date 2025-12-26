# Руководство по тестированию и автоматизации проверки качества кода

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

#### B. Playwright - E2E тестирование (найдет проблемы как с поиском)

```bash
npm install --save-dev @playwright/test
npx playwright install
```

**Создать `tests/shopping-list.spec.ts`:**

```typescript
import { test, expect } from '@playwright/test';

test.describe('Shopping List', () => {
  test('добавление товара через поиск', async ({ page }) => {
    await page.goto('http://localhost:3000');

    // Поиск товара
    await page.fill('input[placeholder*="Поиск"]', 'молоко');
    await page.waitForSelector('text=Молоко');

    // Добавление в список
    await page.click('text=Молоко');

    // Проверка что добавлено
    await page.waitForSelector('text=добавлен в список');
  });

  test('добавление товара через категории', async ({ page }) => {
    await page.goto('http://localhost:3000/categories');

    // Выбор категории
    await page.click('text=Молочные продукты');

    // Выбор товара
    await page.click('text=Молоко');
    await page.click('text=Добавить в список');

    // Проверка редиректа
    await expect(page).toHaveURL(/\/lists/);
  });
});
```

**Добавить в package.json:**

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

#### C. Vitest - Unit тестирование

```bash
npm install --save-dev vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom
```

**Создать `vitest.config.ts`:**

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
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
    // Очистка store перед каждым тестом
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

**Добавить в package.json:**

```json
{
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui"
  }
}
```

#### D. Lighthouse CI - Проверка производительности и доступности

```bash
npm install --save-dev @lhci/cli
```

**Создать `lighthouserc.json`:**

```json
{
  "ci": {
    "collect": {
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

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Type check
        run: npx tsc --noEmit

      - name: Unit tests
        run: npm test

      - name: Build
        run: npm run build

      - name: E2E tests
        run: |
          npm run build
          npm start & npx wait-on http://localhost:3000
          npm run test:e2e
```

---

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

### Code Coverage (с Vitest)

```bash
npm test -- --coverage
```

**Добавить в `vitest.config.ts`:**

```typescript
export default defineConfig({
  test: {
    coverage: {
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
npm install --save-dev prettier eslint-config-prettier @playwright/test husky lint-staged

# Настройка
npx husky init
npx playwright install

# Добавить скрипты в package.json
npm pkg set scripts.format="prettier --write \"src/**/*.{ts,tsx}\""
npm pkg set scripts.test:e2e="playwright test"
npm pkg set scripts.typecheck="tsc --noEmit"

# Создать .prettierrc.json
echo '{"semi":true,"singleQuote":true,"tabWidth":2}' > .prettierrc.json
```

---

## Дополнительные ресурсы

- [Next.js Testing Guide](https://nextjs.org/docs/testing)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [React Testing Library](https://testing-library.com/react)
- [TypeScript Strict Mode](https://www.typescriptlang.org/tsconfig#strict)
