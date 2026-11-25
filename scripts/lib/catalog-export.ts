import type {
  CatalogAuditScope,
  CatalogExportCounts,
  CatalogImageEntry,
} from '../../src/lib/services/emoji-detail';

// Parser of a catalogue export JSON for the detail audit. It lives outside `src` (AGE-1667 Ya3)
// because it still understands the legacy `imageUrlEn` field of exports taken before the picture
// dictionary; no runtime code reads that field.

// A catalogue export (JSON) keeps the English picture of a product or variant in `localizedImages.en`
// or, in an export taken before AGE-1667 Ya3, in the legacy `imageUrlEn` field.
type RawVariant = {
  id?: unknown;
  name?: unknown;
  nameEn?: unknown;
  imageUrl?: unknown;
  imageUrlEn?: unknown;
  localizedImages?: unknown;
};

type RawProduct = {
  id?: unknown;
  name?: unknown;
  nameEn?: unknown;
  imageUrl?: unknown;
  imageUrlEn?: unknown;
  localizedImages?: unknown;
  variants?: unknown;
};

type RawCategory = {
  id?: unknown;
  name?: unknown;
  nameEn?: unknown;
  imageUrl?: unknown;
  products?: unknown;
};

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid catalog export: ${label} must be string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid catalog export: missing string ${label}`);
  }
  return value;
}

// The English picture of one exported record: the dictionary entry when there is one, otherwise the
// legacy field of an older export.
function englishPictureOf(
  raw: { imageUrlEn?: unknown; localizedImages?: unknown },
  label: string
): string | null {
  const dictionary = raw.localizedImages;
  if (dictionary !== undefined && dictionary !== null) {
    if (typeof dictionary !== 'object' || Array.isArray(dictionary)) {
      throw new Error(`Invalid catalog export: ${label}.localizedImages must be an object`);
    }
    const fromDictionary = optionalString(
      (dictionary as Record<string, unknown>).en,
      `${label}.localizedImages.en`
    );
    if (fromDictionary) return fromDictionary;
  }
  return optionalString(raw.imageUrlEn, `${label}.imageUrlEn`);
}

export function parseCatalogExport(
  rawJson: unknown,
  scope: CatalogAuditScope = 'products'
): { entries: CatalogImageEntry[]; counts: CatalogExportCounts } {
  if (typeof rawJson !== 'object' || rawJson === null || Array.isArray(rawJson)) {
    throw new Error('Invalid catalog export: expected top-level JSON object');
  }
  const top = rawJson as { categories?: unknown };
  if (!Array.isArray(top.categories)) {
    throw new Error('Invalid catalog export: missing "categories" array');
  }

  const allSlots: CatalogImageEntry[] = [];
  const counts: CatalogExportCounts = {
    categories: 0,
    products: 0,
    variants: 0,
    productPrimary: 0,
    productEn: 0,
    variantPrimary: 0,
    variantEn: 0,
    categoryPrimary: 0,
    totalSlots: 0,
  };

  for (let ci = 0; ci < top.categories.length; ci++) {
    const rawCat = top.categories[ci] as RawCategory;
    if (typeof rawCat !== 'object' || rawCat === null || Array.isArray(rawCat)) {
      throw new Error(`Invalid catalog export: categories[${ci}] must be an object`);
    }
    counts.categories++;
    const catName = requiredString(rawCat.name, `categories[${ci}].name`);
    const catNameEn = optionalString(rawCat.nameEn, `categories[${ci}].nameEn`) ?? '';
    const catId = optionalString(rawCat.id, `categories[${ci}].id`) ?? undefined;
    const catImg = optionalString(rawCat.imageUrl, `categories[${ci}].imageUrl`);
    if (catImg) {
      counts.categoryPrimary++;
      allSlots.push({
        ...(catId ? { id: catId } : {}),
        kind: 'category',
        field: 'imageUrl',
        category: catName,
        name: catName,
        nameEn: catNameEn,
        url: catImg,
      });
    }

    if (!Array.isArray(rawCat.products)) {
      throw new Error(`Invalid catalog export: categories[${ci}].products must be an array`);
    }
    for (let pi = 0; pi < rawCat.products.length; pi++) {
      const rawProd = rawCat.products[pi] as RawProduct;
      if (typeof rawProd !== 'object' || rawProd === null || Array.isArray(rawProd)) {
        throw new Error(
          `Invalid catalog export: categories[${ci}].products[${pi}] must be an object`
        );
      }
      counts.products++;
      const prodName = requiredString(rawProd.name, `categories[${ci}].products[${pi}].name`);
      const prodNameEn =
        optionalString(rawProd.nameEn, `categories[${ci}].products[${pi}].nameEn`) ?? '';
      const prodId =
        optionalString(rawProd.id, `categories[${ci}].products[${pi}].id`) ?? undefined;
      const prodImg = optionalString(rawProd.imageUrl, `products[${pi}].imageUrl`);
      const prodImgEn = englishPictureOf(rawProd, `products[${pi}]`);

      if (prodImg) {
        counts.productPrimary++;
        allSlots.push({
          ...(prodId ? { id: prodId } : {}),
          kind: 'product',
          field: 'imageUrl',
          category: catName,
          name: prodName,
          nameEn: prodNameEn,
          url: prodImg,
        });
      }
      if (prodImgEn) {
        counts.productEn++;
        allSlots.push({
          ...(prodId ? { id: prodId } : {}),
          kind: 'product',
          field: 'englishPicture',
          category: catName,
          name: prodName,
          nameEn: prodNameEn,
          url: prodImgEn,
        });
      }

      if (rawProd.variants !== undefined) {
        if (!Array.isArray(rawProd.variants)) {
          throw new Error(`Invalid catalog export: products[${pi}].variants must be an array`);
        }
        for (let vi = 0; vi < rawProd.variants.length; vi++) {
          const rawVar = rawProd.variants[vi] as RawVariant;
          if (typeof rawVar !== 'object' || rawVar === null || Array.isArray(rawVar)) {
            throw new Error(`Invalid catalog export: variants[${vi}] must be an object`);
          }
          counts.variants++;
          const varName = requiredString(rawVar.name, `variants[${vi}].name`);
          const varNameEn = optionalString(rawVar.nameEn, `variants[${vi}].nameEn`) ?? '';
          const varId = optionalString(rawVar.id, `variants[${vi}].id`) ?? undefined;
          const varImg = optionalString(rawVar.imageUrl, `variants[${vi}].imageUrl`);
          const varImgEn = englishPictureOf(rawVar, `variants[${vi}]`);

          if (varImg) {
            counts.variantPrimary++;
            allSlots.push({
              ...(varId ? { id: varId } : {}),
              kind: 'variant',
              field: 'imageUrl',
              category: catName,
              parent: prodName,
              name: varName,
              nameEn: varNameEn,
              url: varImg,
            });
          }
          if (varImgEn) {
            counts.variantEn++;
            allSlots.push({
              ...(varId ? { id: varId } : {}),
              kind: 'variant',
              field: 'englishPicture',
              category: catName,
              parent: prodName,
              name: varName,
              nameEn: varNameEn,
              url: varImgEn,
            });
          }
        }
      }
    }
  }

  counts.totalSlots = allSlots.length;
  const entries =
    scope === 'all'
      ? allSlots
      : allSlots.filter((entry) => entry.kind === 'product' && entry.field === 'imageUrl');
  return { entries, counts };
}
