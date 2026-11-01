import type { Prisma } from '@prisma/client';

// One-off catalogue cleanup (operator decision of 2026-11-01): duplicate products are merged into
// the singular one, a few specific products become variants of their base product, misfiled
// products move to their category and English typos are fixed. Every step finds its products by
// the exact Russian and English names and is skipped when it was already applied, so the cleanup
// can be run again safely.

type Tx = Prisma.TransactionClient;
type ProductRef = { name: string; nameEn: string };

export type CatalogCleanupPlan = {
  // `drop` is folded into `keep`: list items, history, favorites and variants move over.
  merges: { keep: ProductRef; drop: ProductRef }[];
  // `child` becomes a variant of `parent` named `name` / `nameEn`, with the child's picture.
  variants: { parent: ProductRef; child: ProductRef; name: string; nameEn: string }[];
  moves: { product: ProductRef; categoryEn: string }[];
  renames: { product: ProductRef; to: Partial<ProductRef> }[];
};

export const CATALOG_CLEANUP_PLAN: CatalogCleanupPlan = {
  merges: [
    { keep: { name: 'Яблоко', nameEn: 'Apple' }, drop: { name: 'Яблоки', nameEn: 'Apples' } },
    { keep: { name: 'Помидор', nameEn: 'Tomato' }, drop: { name: 'Помидоры', nameEn: 'Tomatoes' } },
    { keep: { name: 'Персик', nameEn: 'Peach' }, drop: { name: 'Персики', nameEn: 'Peaches' } },
    { keep: { name: 'Йогурт', nameEn: 'Yogurt' }, drop: { name: 'Йогурт', nameEn: 'yogurt' } },
    {
      keep: { name: 'Детский сок', nameEn: 'Juice for kids' },
      drop: { name: 'Сок детский', nameEn: 'Baby juice' },
    },
    { keep: { name: 'Кетчуп', nameEn: 'Ketchup' }, drop: { name: 'кетчуп', nameEn: 'ketchup' } },
  ],
  variants: [
    {
      parent: { name: 'Яблоко', nameEn: 'Apple' },
      child: { name: 'Яблоко Ханикрисп', nameEn: 'Honey crisp apple' },
      name: 'Яблоко Ханикрисп',
      nameEn: 'Honeycrisp apple',
    },
    {
      parent: { name: 'Хлеб', nameEn: 'Bread' },
      child: { name: 'Хлеб белый', nameEn: 'White Bread' },
      name: 'Хлеб белый',
      nameEn: 'White bread',
    },
    {
      parent: { name: 'Хлеб', nameEn: 'Bread' },
      child: { name: 'хлеб ржаной', nameEn: 'riy braed' },
      name: 'Хлеб ржаной',
      nameEn: 'Rye bread',
    },
  ],
  moves: [
    { product: { name: 'Оливковое масло', nameEn: 'Olive Oil' }, categoryEn: 'Oils & Sauces' },
    { product: { name: 'Куркума', nameEn: 'Turmeric' }, categoryEn: 'Oils & Sauces' },
    { product: { name: 'Лобстер', nameEn: 'Lobster' }, categoryEn: 'Fish & Seafood' },
  ],
  renames: [
    { product: { name: 'Печенье', nameEn: 'Coockies' }, to: { nameEn: 'Cookies' } },
    { product: { name: 'Сухарики', nameEn: 'croutons' }, to: { nameEn: 'Croutons' } },
    { product: { name: 'Мамалыга', nameEn: 'Corn grits ' }, to: { nameEn: 'Corn grits' } },
  ],
};

const label = (ref: ProductRef) => `${ref.name} / ${ref.nameEn.trim()}`;

// The catalogue product with exactly these names; null when there is none, an error when the
// names are ambiguous, since merging the wrong one cannot be undone.
async function findProduct(tx: Tx, ref: ProductRef) {
  const found = await tx.product.findMany({
    where: { name: ref.name, nameEn: ref.nameEn, isGlobal: true },
    include: { variants: { select: { id: true, name: true } } },
  });
  if (found.length > 1) throw new Error(`Ambiguous product ${label(ref)}: ${found.length} matches`);
  return found[0] ?? null;
}

// Moves the product favorites of `fromId` to `toId`; a user who starred both keeps one favorite
// with both usage counts.
async function moveFavorites(tx: Tx, fromId: string, toId: string) {
  const favorites = await tx.favorite.findMany({ where: { productId: fromId } });
  for (const favorite of favorites) {
    const existing = await tx.favorite.findUnique({
      where: { userId_productId: { userId: favorite.userId, productId: toId } },
    });
    if (existing) {
      await tx.favorite.update({
        where: { id: existing.id },
        data: { usageCount: existing.usageCount + favorite.usageCount },
      });
      await tx.favorite.delete({ where: { id: favorite.id } });
    } else {
      await tx.favorite.update({ where: { id: favorite.id }, data: { productId: toId } });
    }
  }
  return favorites.length;
}

export async function applyCatalogCleanup(
  tx: Tx,
  plan: CatalogCleanupPlan,
  log: (line: string) => void
) {
  for (const { keep: keepRef, drop: dropRef } of plan.merges) {
    const [keep, drop] = [await findProduct(tx, keepRef), await findProduct(tx, dropRef)];
    if (!drop) {
      log(`merge ${label(dropRef)} → ${label(keepRef)}: already done`);
      continue;
    }
    if (!keep) throw new Error(`Merge target ${label(keepRef)} not found`);

    await tx.productVariant.updateMany({
      where: { productId: drop.id },
      data: { productId: keep.id },
    });
    const items = await tx.item.updateMany({
      where: { productId: drop.id },
      data: { productId: keep.id },
    });
    const history = await tx.listHistoryItem.updateMany({
      where: { productId: drop.id },
      data: { productId: keep.id },
    });
    const favorites = await moveFavorites(tx, drop.id, keep.id);
    // The duplicate's own picture is kept when the singular product has none.
    if (!(keep.isCustom && keep.imageUrl) && drop.isCustom && drop.imageUrl) {
      await tx.product.update({
        where: { id: keep.id },
        data: { isCustom: true, imageUrl: drop.imageUrl, imageUrlEn: drop.imageUrlEn },
      });
    }
    await tx.product.delete({ where: { id: drop.id } });
    log(
      `merge ${label(dropRef)} → ${label(keepRef)}: ${items.count} list items, ` +
        `${history.count} history items, ${favorites} favorites, ${drop.variants.length} variants`
    );
  }

  for (const step of plan.variants) {
    const [parent, child] = [await findProduct(tx, step.parent), await findProduct(tx, step.child)];
    if (!child) {
      log(`variant ${label(step.child)} → ${label(step.parent)}: already done`);
      continue;
    }
    if (!parent) throw new Error(`Variant parent ${label(step.parent)} not found`);
    if (child.variants.length > 0) {
      throw new Error(`${label(step.child)} has variants of its own and cannot become one`);
    }

    const variant =
      (await tx.productVariant.findFirst({ where: { productId: parent.id, name: step.name } })) ??
      (await tx.productVariant.create({
        data: {
          productId: parent.id,
          name: step.name,
          nameEn: step.nameEn,
          emoji: child.emoji,
          imageUrl: child.isCustom ? child.imageUrl : null,
          imageUrlEn: child.isCustom ? child.imageUrlEn : null,
        },
      }));
    const moved = { productId: parent.id, variantId: variant.id };
    const items = await tx.item.updateMany({ where: { productId: child.id }, data: moved });
    const history = await tx.listHistoryItem.updateMany({
      where: { productId: child.id },
      data: moved,
    });
    // A star on the old product becomes a star on the variant: still a card of its own.
    const favorites = await tx.favorite.findMany({ where: { productId: child.id } });
    for (const favorite of favorites) {
      await tx.variantFavorite.upsert({
        where: { userId_variantId: { userId: favorite.userId, variantId: variant.id } },
        update: { usageCount: { increment: favorite.usageCount } },
        create: { userId: favorite.userId, variantId: variant.id, usageCount: favorite.usageCount },
      });
    }
    await tx.product.delete({ where: { id: child.id } });
    log(
      `variant ${label(step.child)} → ${label(step.parent)} as "${step.name}": ` +
        `${items.count} list items, ${history.count} history items, ${favorites.length} favorites`
    );
  }

  for (const { product: ref, categoryEn } of plan.moves) {
    const product = await findProduct(tx, ref);
    const category = await tx.category.findFirst({ where: { nameEn: categoryEn } });
    if (!product) throw new Error(`Product to move ${label(ref)} not found`);
    if (!category) throw new Error(`Category ${categoryEn} not found`);
    if (product.categoryId === category.id) {
      log(`move ${label(ref)} → ${categoryEn}: already done`);
      continue;
    }
    await tx.product.update({ where: { id: product.id }, data: { categoryId: category.id } });
    log(`move ${label(ref)} → ${categoryEn}`);
  }

  for (const { product: ref, to } of plan.renames) {
    const product = await findProduct(tx, ref);
    if (!product) {
      log(`rename ${label(ref)}: already done`);
      continue;
    }
    await tx.product.update({ where: { id: product.id }, data: to });
    log(`rename ${label(ref)} → ${label({ ...ref, ...to })}`);
  }
}
