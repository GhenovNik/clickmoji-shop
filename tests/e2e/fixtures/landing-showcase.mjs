import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const E2E_LIST_ID = 'e2e-active-list';
export const E2E_AUTH_COOKIE = 'clickmoji-e2e-auth';
export const E2E_AUTH_BYPASS_TOKEN = 'e2e-auth-bypass';

export const LANDING_VIEWPORT = { width: 390, height: 520 };
export const LANDING_DEVICE_SCALE_FACTOR = 2;
export const LANDING_WEBP_OPTIONS = { quality: 88, effort: 6 };
export const LANDING_LOCALES = ['ru', 'en'];

export const LANDING_VIEWS = [
  {
    view: 'product-cards',
    route: '/categories/cat-veg/products',
    scrollY: 0,
    description:
      'Vegetables category product cards (Tomato and Onion selected) and add-to-list bar visible',
  },
  {
    view: 'shopping-list',
    route: `/lists/${E2E_LIST_ID}`,
    scrollY: 0,
    description:
      'Active shopping list in list view with category groups, notes, and purchased item',
  },
  {
    view: 'shopping-grid',
    route: `/lists/${E2E_LIST_ID}`,
    scrollY: 120,
    description:
      'Active shopping list toggled to compact tile/grid view and scrolled to show purchased section',
  },
];

export const COMMITTED_LANDING_ASSETS = [
  {
    locale: 'ru',
    view: 'product-cards',
    assetPath: 'src/assets/landing/ru/product-cards.webp',
    width: 780,
    height: 1040,
    bytes: 38108,
    sha256: '576f18a64673043cda3dc500985d067334c32abef7d9b539e644416cfd1a9ce2',
  },
  {
    locale: 'ru',
    view: 'shopping-list',
    assetPath: 'src/assets/landing/ru/shopping-list.webp',
    width: 780,
    height: 1040,
    bytes: 43494,
    sha256: '0ec8e647f8a7b99fcbd61c3a4d013b12d227cc10b75ac42bf74bb9d9d33a3d95',
  },
  {
    locale: 'ru',
    view: 'shopping-grid',
    assetPath: 'src/assets/landing/ru/shopping-grid.webp',
    width: 780,
    height: 1040,
    bytes: 39678,
    sha256: '92bd2a67ae10bcb74c21b67c95e12b0d95500c30ca996f4b7e5ee648b178da33',
  },
  {
    locale: 'en',
    view: 'product-cards',
    assetPath: 'src/assets/landing/en/product-cards.webp',
    width: 780,
    height: 1040,
    bytes: 37670,
    sha256: '4904935979ec20ab56dad4cdc9fd2014d8a416c2de79e2808eb01698a8dd452b',
  },
  {
    locale: 'en',
    view: 'shopping-list',
    assetPath: 'src/assets/landing/en/shopping-list.webp',
    width: 780,
    height: 1040,
    bytes: 41504,
    sha256: 'eaf03761c596d3f9a6d8cd0696d599a4b2ba38277c58c72ca09cabba25351a84',
  },
  {
    locale: 'en',
    view: 'shopping-grid',
    assetPath: 'src/assets/landing/en/shopping-grid.webp',
    width: 780,
    height: 1040,
    bytes: 37562,
    sha256: 'abae14ec733d9d2b04a36298023e6c647483ce51cf87083198e70525860c5249',
  },
];

const categories = [
  {
    id: 'cat-veg',
    name: 'Овощи',
    nameEn: 'Vegetables',
    emoji: '🥬',
    isCustom: false,
    imageUrl: null,
    order: 1,
  },
  {
    id: 'cat-fruit',
    name: 'Фрукты',
    nameEn: 'Fruit',
    emoji: '🍎',
    isCustom: false,
    imageUrl: null,
    order: 2,
  },
  {
    id: 'cat-dairy',
    name: 'Молочные продукты',
    nameEn: 'Dairy',
    emoji: '🥛',
    isCustom: false,
    imageUrl: null,
    order: 3,
  },
  {
    id: 'cat-bakery',
    name: 'Выпечка',
    nameEn: 'Bakery',
    emoji: '🥖',
    isCustom: false,
    imageUrl: null,
    order: 4,
  },
];

const catalogProducts = [
  {
    id: 'demo-tomato',
    name: 'Помидор',
    nameEn: 'Tomato',
    emoji: '🍅',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[0],
  },
  {
    id: 'demo-apple',
    name: 'Яблоко',
    nameEn: 'Apple',
    emoji: '🍎',
    isCustom: false,
    imageUrl: null,
    variants: [
      { id: 'var-honeycrisp', name: 'Ханикрисп', nameEn: 'Honeycrisp', emoji: '🍎' },
      { id: 'var-gala', name: 'Гала', nameEn: 'Gala', emoji: '🍎' },
      { id: 'var-granny', name: 'Гренни Смит', nameEn: 'Granny Smith', emoji: '🍏' },
    ],
    category: categories[1],
  },
  {
    id: 'demo-avocado',
    name: 'Авокадо',
    nameEn: 'Avocado',
    emoji: '🥑',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[1],
  },
  {
    id: 'demo-milk',
    name: 'Молоко',
    nameEn: 'Milk',
    emoji: '🥛',
    isCustom: false,
    imageUrl: null,
    variants: [
      { id: 'var-whole', name: '3.2%', nameEn: 'Whole', emoji: '🥛' },
      { id: 'var-oat', name: 'Овсяное', nameEn: 'Oat', emoji: '🌾' },
    ],
    category: categories[2],
  },
  {
    id: 'demo-baguette',
    name: 'Багет',
    nameEn: 'Baguette',
    emoji: '🥖',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[3],
  },
  {
    id: 'demo-cheese',
    name: 'Сыр',
    nameEn: 'Cheese',
    emoji: '🧀',
    isCustom: false,
    imageUrl: null,
    variants: [
      { id: 'var-cheddar', name: 'Чеддер', nameEn: 'Cheddar', emoji: '🧀' },
      { id: 'var-mozzarella', name: 'Моцарелла', nameEn: 'Mozzarella', emoji: '🧀' },
    ],
    category: categories[2],
  },
  {
    id: 'demo-strawberry',
    name: 'Клубника',
    nameEn: 'Strawberry',
    emoji: '🍓',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[1],
  },
  {
    id: 'demo-croissant',
    name: 'Круассан',
    nameEn: 'Croissant',
    emoji: '🥐',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[3],
  },
  {
    id: 'demo-egg',
    name: 'Яйца',
    nameEn: 'Eggs',
    emoji: '🥚',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[2],
  },
  // Vegetables from prisma/seed.ts (category "Овощи"); appended so list-view indexes above stay stable.
  {
    id: 'demo-cucumber',
    name: 'Огурец',
    nameEn: 'Cucumber',
    emoji: '🥒',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[0],
  },
  {
    id: 'demo-carrot',
    name: 'Морковь',
    nameEn: 'Carrot',
    emoji: '🥕',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[0],
  },
  {
    id: 'demo-onion',
    name: 'Лук',
    nameEn: 'Onion',
    emoji: '🧅',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[0],
  },
  {
    id: 'demo-garlic',
    name: 'Чеснок',
    nameEn: 'Garlic',
    emoji: '🧄',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[0],
  },
  {
    id: 'demo-potato',
    name: 'Картофель',
    nameEn: 'Potato',
    emoji: '🥔',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[0],
  },
  {
    id: 'demo-broccoli',
    name: 'Брокколи',
    nameEn: 'Broccoli',
    emoji: '🥦',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[0],
  },
  {
    id: 'demo-cabbage',
    name: 'Капуста',
    nameEn: 'Cabbage',
    emoji: '🥬',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[0],
  },
  {
    id: 'demo-eggplant',
    name: 'Баклажан',
    nameEn: 'Eggplant',
    emoji: '🍆',
    isCustom: false,
    imageUrl: null,
    variants: [],
    category: categories[0],
  },
];

function makeShoppingItems(locale) {
  const isRu = locale === 'ru';
  return [
    {
      id: 'item-tomato',
      isPurchased: false,
      note: isRu ? 'Спелые, на ветке' : 'Ripe, on the vine',
      variant: null,
      product: { ...catalogProducts[0] },
    },
    {
      id: 'item-avocado',
      isPurchased: false,
      note: null,
      variant: null,
      product: { ...catalogProducts[2] },
    },
    {
      id: 'item-apple',
      isPurchased: false,
      note: null,
      variant: null,
      product: { ...catalogProducts[1] },
    },
    {
      id: 'item-milk',
      isPurchased: false,
      note: isRu ? 'Без лактозы, 2 пакета' : 'Lactose-free, 2 cartons',
      variant: null,
      product: { ...catalogProducts[3] },
    },
    {
      id: 'item-cheese',
      isPurchased: false,
      note: null,
      variant: null,
      product: { ...catalogProducts[5] },
    },
    {
      id: 'item-baguette',
      isPurchased: true,
      note: null,
      variant: null,
      product: { ...catalogProducts[4] },
    },
  ];
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function findCommittedAsset(locale, view) {
  const asset = COMMITTED_LANDING_ASSETS.find(
    (entry) => entry.locale === locale && entry.view === view
  );
  if (!asset) {
    throw new Error(`Unknown landing showcase asset: ${locale}/${view}`);
  }
  return asset;
}

export async function compareWebpPixels(committedBuffer, capturedBuffer) {
  const [committedRaw, capturedRaw] = await Promise.all([
    sharp(committedBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(capturedBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  if (
    committedRaw.info.width !== capturedRaw.info.width ||
    committedRaw.info.height !== capturedRaw.info.height
  ) {
    return {
      dimensionsMatch: false,
      committedDimensions: `${committedRaw.info.width}x${committedRaw.info.height}`,
      capturedDimensions: `${capturedRaw.info.width}x${capturedRaw.info.height}`,
      totalPixels: null,
      diffPixels: null,
      diffPixelsOver20: null,
      maxChannelDiff: null,
      meanChannelDiff: null,
    };
  }

  const totalPixels = committedRaw.info.width * committedRaw.info.height;
  let diffPixels = 0;
  let diffPixelsOver20 = 0;
  let maxChannelDiff = 0;
  let sumDiff = 0;

  for (let i = 0; i < committedRaw.data.length; i += 4) {
    const diff = Math.max(
      Math.abs(committedRaw.data[i] - capturedRaw.data[i]),
      Math.abs(committedRaw.data[i + 1] - capturedRaw.data[i + 1]),
      Math.abs(committedRaw.data[i + 2] - capturedRaw.data[i + 2])
    );
    if (diff > 0) {
      diffPixels += 1;
      sumDiff += diff;
      if (diff > 20) diffPixelsOver20 += 1;
      if (diff > maxChannelDiff) maxChannelDiff = diff;
    }
  }

  return {
    dimensionsMatch: true,
    committedDimensions: `${committedRaw.info.width}x${committedRaw.info.height}`,
    capturedDimensions: `${capturedRaw.info.width}x${capturedRaw.info.height}`,
    totalPixels,
    diffPixels,
    diffPixelsOver20,
    maxChannelDiff,
    meanChannelDiff: Number((sumDiff / totalPixels).toFixed(3)),
  };
}

export async function setupLandingShowcaseMocks(page, locale, { authenticated = true } = {}) {
  const listName = locale === 'ru' ? 'Покупки на выходные' : 'Weekend groceries';
  const items = makeShoppingItems(locale);

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === '/api/auth/session') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          authenticated
            ? {
                user: { id: 'demo-user', name: 'Demo', email: 'demo@example.com', role: 'USER' },
                expires: '2099-01-01T00:00:00.000Z',
              }
            : {}
        ),
      });
    }
    if (pathname === '/api/categories') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(categories),
      });
    }
    if (pathname === '/api/products') {
      // The app requests /api/products?categoryId=<id>; honour it so each category page shows only its own products.
      const categoryId = url.searchParams.get('categoryId');
      const products = categoryId
        ? catalogProducts.filter((product) => product.category.id === categoryId)
        : catalogProducts;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(products),
      });
    }
    if (pathname === '/api/lists') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: E2E_LIST_ID, name: listName, isActive: true, _count: { items: items.length } },
        ]),
      });
    }
    if (pathname === `/api/lists/${E2E_LIST_ID}`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: E2E_LIST_ID, name: listName, items }),
      });
    }
    if (pathname === '/api/favorites') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'fav-1', product: catalogProducts[2], variant: null }]),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

async function stripShellChrome(page, { pinBottomBar = false } = {}) {
  await page.evaluate((shouldPinBar) => {
    document.querySelector('header')?.remove();
    document.querySelector('nav')?.remove();
    const main = document.querySelector('main');
    if (main) main.style.paddingTop = '0px';
    if (shouldPinBar) {
      const bar = document.querySelector('.bottom-above-mobile-nav');
      if (bar instanceof HTMLElement) bar.style.bottom = '0px';
    }
    window.scrollTo(0, 0);
  }, pinBottomBar);
}

export async function captureLandingShowcaseLocale(page, locale, { rootDir = process.cwd() } = {}) {
  const captures = [];

  // 1. Product cards screen
  await page.goto('/categories/cat-veg/products', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const cards = page.getByTestId('product-card');
  await cards.nth(0).waitFor({ state: 'visible' });
  await cards.nth(0).click();
  await cards.nth(3).click();
  await page.waitForTimeout(200);
  await stripShellChrome(page, { pinBottomBar: true });
  await page.waitForTimeout(150);
  const cardsPng = await page.screenshot({ animations: 'disabled' });
  captures.push({ view: 'product-cards', png: cardsPng });

  // 2. Shopping list view
  await page.goto(`/lists/${E2E_LIST_ID}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.getByTestId('shopping-item').first().waitFor({ state: 'visible' });
  await stripShellChrome(page);
  await page.waitForTimeout(150);
  const listPng = await page.screenshot({ animations: 'disabled' });
  captures.push({ view: 'shopping-list', png: listPng });

  // 3. Compact grid view
  const gridBtn = page.getByRole('button', {
    name: locale === 'ru' ? 'Плитка' : 'Grid',
    exact: true,
  });
  await gridBtn.click();
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForTimeout(150);
  const gridPng = await page.screenshot({ animations: 'disabled' });
  captures.push({ view: 'shopping-grid', png: gridPng });

  const results = [];
  for (const { view, png } of captures) {
    const viewSpec = LANDING_VIEWS.find((entry) => entry.view === view);
    const committedSpec = findCommittedAsset(locale, view);
    const committedBuffer = readFileSync(path.join(rootDir, committedSpec.assetPath));
    const webp = await sharp(png).webp(LANDING_WEBP_OPTIONS).toBuffer();
    const [pngMeta, webpMeta, committedMeta, pixelComparison] = await Promise.all([
      sharp(png).metadata(),
      sharp(webp).metadata(),
      sharp(committedBuffer).metadata(),
      compareWebpPixels(committedBuffer, webp),
    ]);

    const capturedWebpSha256 = sha256(webp);
    const committedDiskSha256 = sha256(committedBuffer);

    results.push({
      locale,
      view,
      route: viewSpec.route,
      scrollY: viewSpec.scrollY,
      description: viewSpec.description,
      viewport: LANDING_VIEWPORT,
      deviceScaleFactor: LANDING_DEVICE_SCALE_FACTOR,
      conversion: { library: 'sharp', format: 'webp', options: LANDING_WEBP_OPTIONS },
      sourcePng: {
        buffer: png,
        bytes: png.length,
        sha256: sha256(png),
        width: pngMeta.width,
        height: pngMeta.height,
        format: pngMeta.format,
      },
      capturedWebp: {
        buffer: webp,
        bytes: webp.length,
        sha256: capturedWebpSha256,
        width: webpMeta.width,
        height: webpMeta.height,
        format: webpMeta.format,
      },
      committedAsset: {
        path: committedSpec.assetPath,
        bytes: committedBuffer.length,
        sha256: committedDiskSha256,
        pinnedSha256: committedSpec.sha256,
        width: committedMeta.width,
        height: committedMeta.height,
        format: committedMeta.format,
      },
      byteIdentical: capturedWebpSha256 === committedDiskSha256,
      pixelComparison,
    });
  }

  return results;
}
