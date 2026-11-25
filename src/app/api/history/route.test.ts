// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeListDb, product, type FakeItem } from '@/test/fake-list-db';
import { productImageUrl } from '@/lib/product-image';

// Completing a list moves its items into a history snapshot. Whatever happens concurrently, an
// item must end up in exactly one place: in the snapshot or still in the list.

const holder = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeListDb>,
  requireUser: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({ requireUser: holder.requireUser }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({}, { get: (_target, prop) => Reflect.get(holder.db.prisma, prop) }),
}));

const { POST } = await import('./route');

const item = (id: string, productId: string, listId = 'list-b'): FakeItem => ({
  id,
  listId,
  productId,
  variantId: null,
  note: null,
  isPurchased: false,
  createdAt: new Date('2026-10-01T10:00:00Z'),
});

function complete(listId = 'list-b') {
  return POST(
    new Request('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listId }),
    })
  );
}

const snapshotProductIds = () => holder.db.state.historyItems.map((row) => row.productId);
const listItemIds = (listId = 'list-b') =>
  holder.db.state.items.filter((row) => row.listId === listId).map((row) => row.id);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  holder.requireUser.mockResolvedValue({ session: { user: { id: 'user-b', role: 'USER' } } });
  holder.db = createFakeListDb({
    products: [
      product({ id: 'milk' }),
      product({ id: 'bread' }),
      product({ id: 'eggs' }),
      product({ id: 'foreign-private', isGlobal: false, createdById: 'user-a' }),
    ],
    lists: [
      { id: 'list-b', userId: 'user-b', name: 'Покупки', isActive: true },
      { id: 'list-a', userId: 'user-a', name: 'Чужой', isActive: true },
    ],
    items: [
      item('item-milk', 'milk'),
      item('item-bread', 'bread'),
      item('item-a', 'milk', 'list-a'),
    ],
  });
});

describe('POST /api/history (complete a list)', () => {
  it('keeps an item added after the snapshot was read in the list instead of losing it', async () => {
    // A concurrent POST /api/lists/[listId]/items commits right after the snapshot read.
    let interleaved = false;
    holder.db.hooks.afterItemsRead = () => {
      if (interleaved) return;
      interleaved = true;
      holder.db.state.items.push(item('item-late', 'eggs'));
    };

    const response = await complete();

    expect(response.status).toBe(200);
    expect(interleaved).toBe(true);
    const inSnapshot = snapshotProductIds().includes('eggs');
    const inList = listItemIds().includes('item-late');
    expect({ inSnapshot, inList }).toEqual({ inSnapshot: false, inList: true });
    expect(snapshotProductIds()).toEqual(['milk', 'bread']);
  });

  it('locks the list and then its items before reading the snapshot', async () => {
    // Without the item locks a concurrent PUT (note, isPurchased) could commit between the read
    // and the delete, return 200, and vanish with the item.
    const response = await complete();

    expect(response.status).toBe(200);
    const order = holder.db.calls.filter((call) =>
      ['$queryRaw:lists', '$queryRaw:items', 'item.findMany'].includes(call)
    );
    expect(order).toEqual(['$queryRaw:lists', '$queryRaw:items', 'item.findMany']);
  });

  it('moves every item it read into one snapshot and empties the list', async () => {
    const response = await complete();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.listName).toBe('Покупки');
    expect(body.items.map((row: { productId: string }) => row.productId)).toEqual([
      'milk',
      'bread',
    ]);
    expect(holder.db.state.histories).toHaveLength(1);
    expect(listItemIds()).toEqual([]);
    expect(listItemIds('list-a')).toEqual(['item-a']);
  });

  it('removes a legacy item of a product the user cannot see without copying it', async () => {
    holder.db.state.items.push(item('item-legacy', 'foreign-private'));

    const response = await complete();

    expect(response.status).toBe(200);
    expect(snapshotProductIds()).toEqual(['milk', 'bread']);
    expect(listItemIds()).toEqual([]);
  });

  it('returns 400 for an empty list without creating a snapshot', async () => {
    holder.db.state.items = [];

    const response = await complete();

    expect(response.status).toBe(400);
    expect(holder.db.state.histories).toEqual([]);
  });

  it("returns 404 for another user's list without touching it", async () => {
    const response = await complete('list-a');

    expect(response.status).toBe(404);
    expect(holder.db.state.histories).toEqual([]);
    expect(listItemIds('list-a')).toEqual(['item-a']);
  });

  it('rolls the snapshot back when removing the items fails', async () => {
    const deleteMany = holder.db.prisma.item.deleteMany;
    holder.db.prisma.item.deleteMany = async () => {
      throw new Error('connection reset');
    };

    const response = await complete();
    holder.db.prisma.item.deleteMany = deleteMany;

    expect(response.status).toBe(500);
    expect(holder.db.state.histories).toEqual([]);
    expect(holder.db.state.historyItems).toEqual([]);
    expect(listItemIds()).toEqual(['item-milk', 'item-bread']);
  });
});

// AGE-1667 Ya3 review round 2 (AC-4): a snapshot is taken once and never refilled from today's
// catalogue, so an English address that only the legacy column holds (the previous release writes
// it alone) must be captured when the list is completed, in the same transaction.
describe('POST /api/history: legacy-only English picture (rollout window)', () => {
  const LEGACY = 'https://utfs.io/f/milk-en-legacy';
  const MAIN = 'https://utfs.io/f/milk-main-ru';

  const snapshotOf = (productId: string) =>
    holder.db.state.historyItems.find((row) => row.productId === productId)!;

  function legacyOnlyMilk(overrides: Record<string, unknown> = {}) {
    holder.db.state.products = holder.db.state.products.map((row) =>
      row.id === 'milk'
        ? {
            ...row,
            imageUrl: MAIN,
            imageTextLocale: 'ru',
            localizedImages: null,
            imageUrlEn: LEGACY,
            ...overrides,
          }
        : row
    );
  }

  it('captures the legacy-only English address and keeps it when the catalogue changes later', async () => {
    legacyOnlyMilk();

    const response = await complete();
    expect(response.status).toBe(200);

    const row = snapshotOf('milk');
    expect(row.localizedImages).toEqual({ en: LEGACY });
    expect(row.productImageUrl).toBe(MAIN);
    expect(row.imageTextLocale).toBe('ru');
    expect(productImageUrl(row as never, 'en')).toBe(LEGACY);

    // The catalogue moves on: another picture, the dictionary filled, the legacy column cleared.
    holder.db.state.products = holder.db.state.products.map((candidate) =>
      candidate.id === 'milk'
        ? {
            ...candidate,
            imageUrl: 'https://utfs.io/f/later-main',
            localizedImages: { en: 'https://utfs.io/f/later-en' },
            imageUrlEn: null,
          }
        : candidate
    );

    const stored = snapshotOf('milk');
    expect(productImageUrl(stored as never, 'en')).toBe(LEGACY);
    expect(JSON.stringify(stored)).not.toContain('later');
  });

  it('mirrors the folded address into the rollback column of the snapshot, nowhere else', async () => {
    legacyOnlyMilk();

    await complete();

    expect(snapshotOf('milk').productImageUrlEn).toBe(LEGACY);
  });

  it('lets the dictionary win over the legacy column and keeps every other language', async () => {
    legacyOnlyMilk({
      localizedImages: { en: 'https://utfs.io/f/milk-en-dictionary', ru: MAIN, xx: 'https://x' },
    });

    await complete();

    const row = snapshotOf('milk');
    expect(row.localizedImages).toEqual({
      en: 'https://utfs.io/f/milk-en-dictionary',
      ru: MAIN,
      xx: 'https://x',
    });
    expect(row.productImageUrlEn).toBe('https://utfs.io/f/milk-en-dictionary');
    expect(JSON.stringify(row)).not.toContain('legacy');
  });

  it('adds nothing when the product has no legacy address and no English entry', async () => {
    legacyOnlyMilk({ imageUrlEn: null, localizedImages: { ru: MAIN } });

    await complete();

    const row = snapshotOf('milk');
    expect(row.localizedImages).toEqual({ ru: MAIN });
    expect(row.productImageUrlEn).toBeNull();
  });

  it('does not fall back to the legacy column of a product the user cannot see', async () => {
    holder.db.state.products = holder.db.state.products.map((row) =>
      row.id === 'foreign-private'
        ? {
            ...row,
            imageUrlEn: 'https://utfs.io/f/foreign-legacy',
            imageUrl: 'https://utfs.io/f/f',
          }
        : row
    );
    holder.db.state.items.push(item('item-foreign', 'foreign-private'));

    const response = await complete();

    expect(response.status).toBe(200);
    expect(snapshotProductIds()).toEqual(['milk', 'bread']);
    expect(JSON.stringify(holder.db.state.historyItems)).not.toContain('foreign-legacy');
    expect(listItemIds()).toEqual([]);
  });

  it('reads the pictures of all visible products in the one statement that checks visibility', async () => {
    legacyOnlyMilk();

    await complete();

    // One product query for the whole list (no per-item reads), inside the transaction.
    expect(holder.db.calls.filter((call) => call === 'product.findMany')).toHaveLength(1);
    expect(holder.db.calls[0]).toBe('$transaction');
  });

  it('rolls everything back when the picture read fails', async () => {
    legacyOnlyMilk();
    const findMany = holder.db.prisma.product.findMany;
    holder.db.prisma.product.findMany = async () => {
      throw new Error('connection reset');
    };

    const response = await complete();
    holder.db.prisma.product.findMany = findMany;

    expect(response.status).toBe(500);
    expect(holder.db.state.histories).toEqual([]);
    expect(holder.db.state.historyItems).toEqual([]);
    expect(listItemIds()).toEqual(['item-milk', 'item-bread']);
  });
});
