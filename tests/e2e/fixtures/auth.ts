import type { Page, Route } from '@playwright/test';

export const E2E_LIST_ID = 'e2e-active-list';
export const E2E_AUTH_COOKIE = 'clickmoji-e2e-auth';
export const E2E_AUTH_BYPASS_TOKEN = 'e2e-auth-bypass';

export const e2eCategory = {
  id: 'e2e-category',
  name: 'Молочные продукты',
  emoji: '🥛',
  isCustom: false,
  imageUrl: null,
};

export const e2eMilkProduct = {
  id: 'e2e-milk',
  name: 'Молоко',
  nameEn: 'Milk',
  emoji: '🥛',
  isCustom: false,
  imageUrl: null,
  variants: [],
  category: e2eCategory,
};

export type E2EShoppingItem = {
  id: string;
  isPurchased: boolean;
  note: string | null;
  product: {
    id: string;
    name: string;
    emoji: string;
    isCustom: boolean;
    imageUrl: string | null;
    category: {
      name: string;
      emoji: string;
      order: number;
    };
  };
  variant: null;
};

export type MockShoppingState = {
  items: E2EShoppingItem[];
  addItemRequests: unknown[];
  listRequests: number;
};

const e2eListSummary = {
  id: E2E_LIST_ID,
  name: 'E2E список',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  _count: { items: 0 },
};

export function createShoppingItem(id: string, product = e2eMilkProduct): E2EShoppingItem {
  return {
    id,
    isPurchased: false,
    note: null,
    variant: null,
    product: {
      id: product.id,
      name: product.name,
      emoji: product.emoji,
      isCustom: product.isCustom,
      imageUrl: product.imageUrl,
      category: {
        name: product.category.name,
        emoji: product.category.emoji,
        order: 1,
      },
    },
  };
}

function json(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

async function fulfillApiRoute(route: Route, state: MockShoppingState) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;

  if (path === '/api/auth/session') {
    await route.fulfill(
      json({
        user: {
          id: 'e2e-user',
          name: 'E2E User',
          email: 'e2e@example.com',
          role: 'USER',
        },
        expires: '2099-01-01T00:00:00.000Z',
      })
    );
    return;
  }

  if (path === '/api/lists') {
    state.listRequests += 1;
    await route.fulfill(
      json([
        {
          ...e2eListSummary,
          _count: { items: state.items.length },
        },
      ])
    );
    return;
  }

  if (path === `/api/lists/${E2E_LIST_ID}`) {
    state.listRequests += 1;
    await route.fulfill(
      json({
        id: E2E_LIST_ID,
        name: 'E2E список',
        items: state.items,
      })
    );
    return;
  }

  if (path === `/api/lists/${E2E_LIST_ID}/items`) {
    const body = request.postDataJSON();
    state.addItemRequests.push(body);

    const item = createShoppingItem(`e2e-item-${state.items.length + 1}`);
    state.items.push(item);

    await route.fulfill(
      json({
        createdItems: [{ id: item.id, productId: e2eMilkProduct.id }],
        message: 'Добавлено 1 товаров.',
      })
    );
    return;
  }

  if (path === '/api/categories') {
    await route.fulfill(json([e2eCategory]));
    return;
  }

  if (path === '/api/products') {
    await route.fulfill(json([e2eMilkProduct]));
    return;
  }

  if (path === '/api/search') {
    const query = url.searchParams.get('q')?.trim();
    await route.fulfill(json(query ? [e2eMilkProduct] : []));
    return;
  }

  if (path === '/api/favorites') {
    await route.fulfill(json([]));
    return;
  }

  await route.fulfill(json({ ok: true }));
}

export async function mockAuthenticatedShopping(page: Page, initialItems: E2EShoppingItem[] = []) {
  const state: MockShoppingState = {
    items: [...initialItems],
    addItemRequests: [],
    listRequests: 0,
  };

  await page.context().addCookies([
    {
      name: E2E_AUTH_COOKIE,
      value: E2E_AUTH_BYPASS_TOKEN,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  await page.route('**/api/**', async (route) => {
    await fulfillApiRoute(route, state);
  });

  return state;
}

export async function mockPublicCatalog(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === '/api/auth/session') {
      await route.fulfill(json({}));
      return;
    }

    if (url.pathname === '/api/categories') {
      await route.fulfill(json([e2eCategory]));
      return;
    }

    if (url.pathname === '/api/products') {
      await route.fulfill(json([e2eMilkProduct]));
      return;
    }

    await route.fulfill(json({ ok: true }));
  });
}
