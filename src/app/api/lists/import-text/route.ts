import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { localizedName } from '@/lib/catalog-name';
import { requireUser } from '@/lib/auth-guards';
import { visibleProductsWhere } from '@/lib/product-visibility';
import {
  checkRateLimit,
  getRequestLocale,
  getServerTranslator,
  rateLimitResponse,
} from '@/lib/auth-security';
import { runTextAiCall } from '@/lib/text-ai-call';
import { textAiErrorCode } from '@/lib/services/text-ai-errors';
import {
  parseShoppingListText,
  type CatalogProductPromptEntry,
  type ParsedShoppingListProduct,
} from '@/lib/services/ai-products';
import {
  isValidEmoji,
  mergeNotes,
  normalizeProductName,
  selectCatalogForPrompt,
  splitProductNameAndNote,
} from '@/lib/product-name';

export const maxDuration = 60;

type CatalogProduct = CatalogProductPromptEntry & { categoryId: string };

export async function POST(request: Request) {
  const locale = getRequestLocale(request);
  // Every message the import window shows is in the request's language.
  const t = getServerTranslator(locale);
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const body = await request.json();
    const { text, listId } = body;

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: t('api.import.textRequired') }, { status: 400 });
    }

    if (text.length > 2000) {
      return NextResponse.json(
        { error: t('api.import.textTooLong', { max: 2000 }) },
        { status: 400 }
      );
    }

    if (!listId) {
      return NextResponse.json({ error: t('api.import.listIdRequired') }, { status: 400 });
    }

    const userLimit = await checkRateLimit({
      key: `ai:import:${session.user.id}`,
      limit: 10,
      windowMs: 60 * 60 * 1000, // 10 requests per hour
    });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.resetAt, locale);
    }

    // Verify list belongs to user
    const list = await prisma.list.findUnique({
      where: {
        id: listId,
        userId: session.user.id,
      },
    });

    if (!list) {
      return NextResponse.json({ error: t('api.import.listNotFound') }, { status: 404 });
    }

    // Check for API key
    const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: t('api.import.aiNotConfigured') }, { status: 500 });
    }

    // Fetch existing categories
    const categories = await prisma.category.findMany({
      select: { id: true, name: true, nameEn: true, order: true },
      orderBy: { order: 'asc' },
    });

    if (categories.length === 0) {
      return NextResponse.json({ error: t('api.import.noCategories') }, { status: 400 });
    }

    const categoryNameOf = new Map(categories.map((category) => [category.id, category.name]));
    // The report shows names in the language of the request.
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const reportCategory = (categoryId: string) => {
      const category = categoryById.get(categoryId);
      return category ? localizedName(category, locale) : '';
    };

    // The model can only reuse products it was shown. Every visible product stays available for
    // server-side matching; the prompt gets a bounded, text-relevant subset.
    const visibleProducts = await prisma.product.findMany({
      where: visibleProductsWhere(session.user.id),
      select: { id: true, name: true, nameEn: true, categoryId: true },
      orderBy: { createdAt: 'asc' },
    });
    const catalog: CatalogProduct[] = visibleProducts.map((product) => ({
      id: product.id,
      name: product.name,
      nameEn: product.nameEn,
      categoryId: product.categoryId,
      categoryName: categoryNameOf.get(product.categoryId) ?? '',
    }));

    const promptCatalog = selectCatalogForPrompt(catalog, text);

    const analysis = await runTextAiCall(session.user, locale, () =>
      parseShoppingListText({ apiKey, text, categories, catalog: promptCatalog })
    );
    if (analysis instanceof Response) return analysis;
    const { products: parsedProducts, invalid: invalidEntries, promptVersion, model } = analysis;

    if (!Array.isArray(parsedProducts) || parsedProducts.length === 0) {
      return NextResponse.json(
        { error: t('api.import.noProductsFound'), parsedData: parsedProducts },
        { status: 400 }
      );
    }

    // Process each product
    const results = {
      added: [] as Array<{ name: string; category: string; note?: string }>,
      created: [] as Array<{ name: string; category: string; note?: string }>,
      skipped: [] as Array<{ name: string; reason: string }>,
      failed: [] as FailedEntry[],
    };

    for (const entry of invalidEntries) {
      results.failed.push(failedEntry(entry, t('api.import.unrecognizedEntry')));
    }

    // Ids the model was shown are trusted only when they belong to the catalog in its prompt;
    // names are compared with the full visible catalog after normalisation.
    const catalogById = new Map(promptCatalog.map((product) => [product.id, product]));
    const catalogByName = new Map<string, CatalogProduct>();
    for (const catalogProduct of catalog) {
      for (const value of [catalogProduct.name, catalogProduct.nameEn]) {
        const key = normalizeProductName(value);
        if (key && !catalogByName.has(key)) catalogByName.set(key, catalogProduct);
      }
    }

    const findCatalogMatch = (product: ParsedShoppingListProduct): CatalogProduct | null => {
      if (product.existingProductId) {
        const byId = catalogById.get(product.existingProductId);
        if (byId) return byId;
      }
      for (const value of [product.nameRu, product.nameEn]) {
        const key = normalizeProductName(value);
        const byName = key ? catalogByName.get(key) : undefined;
        if (byName) return byName;
      }
      return null;
    };

    for (const product of parsedProducts) {
      try {
        const { name: cleanedName, note: nameNote } = splitProductNameAndNote(product.nameRu);
        const note = mergeNotes(product.note, nameNote);
        const nameRu = cleanedName || product.nameRu.trim();
        const nameEn = product.nameEn.trim();
        let dbProduct: { id: string; name: string; nameEn: string; categoryId: string } | null =
          findCatalogMatch(product);

        // A category is needed only to create a missing product.
        if (!dbProduct) {
          if (!nameRu || !nameEn || !product.categoryName.trim()) {
            results.failed.push(
              failedEntry(
                product,
                product.existingProductId
                  ? t('api.import.unknownProductReference')
                  : t('api.import.unrecognizedEntry')
              )
            );
            continue;
          }

          const category = findCategory(categories, product.categoryName);

          if (!category) {
            results.failed.push(
              failedEntry(
                product,
                t('api.import.categoryNotFound', { category: product.categoryName })
              )
            );
            continue;
          }

          // A missing product is created like in smart-create: private to a regular user and
          // global only when an administrator imports it. The placeholder is used only when the
          // model returned nothing that is a single Unicode emoji.
          dbProduct = await prisma.product.create({
            data: {
              name: nameRu,
              nameEn,
              emoji: isValidEmoji(product.emoji) ? product.emoji : '📦',
              categoryId: category.id,
              isCustom: false,
              imageUrl: null,
              isGlobal: session.user.role === 'ADMIN',
              createdById: session.user.id,
            },
          });

          results.created.push({
            name: localizedName(dbProduct, locale),
            category: localizedName(category, locale),
            note,
          });
        }

        // Add to list (duplicates are now allowed)
        await prisma.item.create({
          data: {
            listId: listId,
            productId: dbProduct.id,
            note: note || null,
            isPurchased: false,
          },
        });

        results.added.push({
          name: localizedName(dbProduct, locale),
          category: reportCategory(dbProduct.categoryId),
          note,
        });
      } catch (error) {
        // Log only an allowlisted code, never prompts or upstream error details.
        console.error('Error importing a list entry:', textAiErrorCode(error));
        results.failed.push(failedEntry(product, t('api.import.entryFailed')));
      }
    }

    return NextResponse.json({
      message: t('api.import.summary', {
        added: results.added.length,
        created: results.created.length,
        skipped: results.skipped.length,
        failed: results.failed.length,
      }),
      promptVersion,
      model,
      results,
    });
  } catch (error) {
    console.error('Error importing list:', textAiErrorCode(error));
    return NextResponse.json({ error: t('api.import.importFailed') }, { status: 500 });
  }
}

const normalized = (value: string) => value.trim().toLocaleLowerCase('ru');

// The prompt lists a category with its English name, its local name and a hint; accept the English
// name, the local name or that listed form (with or without the hint), ignoring case and spaces.
function findCategory<T extends { name: string; nameEn: string }>(
  categories: T[],
  categoryName: string
): T | undefined {
  const wanted = normalized(categoryName.replace(/\s+—.*$/u, ''));
  return categories.find((c) =>
    [c.nameEn, c.name, `${c.nameEn} (${c.name})`].some((form) => normalized(form) === wanted)
  );
}

// What the client gets for an entry that was not added: two strings, never the raw AI output, so
// the import report can always be rendered. Missing, empty or non-string names get a fallback.
type FailedEntry = { product: { nameRu: string; nameEn: string }; reason: string };

const UNRECOGNIZED_NAME_RU = 'Нераспознанная позиция';
const UNRECOGNIZED_NAME_EN = 'Unrecognized item';

function failedEntry(entry: unknown, reason: string): FailedEntry {
  const { nameRu, nameEn } = (entry && typeof entry === 'object' ? entry : {}) as Record<
    string,
    unknown
  >;
  const text = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return {
    product: {
      nameRu: text(nameRu, UNRECOGNIZED_NAME_RU),
      nameEn: text(nameEn, UNRECOGNIZED_NAME_EN),
    },
    reason,
  };
}
