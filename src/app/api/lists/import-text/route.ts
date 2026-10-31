import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { visibleProductsWhere } from '@/lib/product-visibility';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
import { enforceAiQuota } from '@/lib/ai-quota';
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

type CatalogProduct = CatalogProductPromptEntry & { categoryId: string };

export async function POST(request: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const body = await request.json();
    const { text, listId } = body;

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    if (text.length > 2000) {
      return NextResponse.json(
        { error: 'Text is too long (maximum 2000 characters)' },
        { status: 400 }
      );
    }

    if (!listId) {
      return NextResponse.json({ error: 'List ID is required' }, { status: 400 });
    }

    const userLimit = await checkRateLimit({
      key: `ai:import:${session.user.id}`,
      limit: 10,
      windowMs: 60 * 60 * 1000, // 10 requests per hour
    });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.resetAt);
    }

    // Verify list belongs to user
    const list = await prisma.list.findUnique({
      where: {
        id: listId,
        userId: session.user.id,
      },
    });

    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 });
    }

    // Check for API key
    const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'AI service not configured. Please contact administrator.' },
        { status: 500 }
      );
    }

    // Fetch existing categories
    const categories = await prisma.category.findMany({
      select: { id: true, name: true, nameEn: true, order: true },
      orderBy: { order: 'asc' },
    });

    if (categories.length === 0) {
      return NextResponse.json(
        { error: 'No categories found. Please contact administrator.' },
        { status: 400 }
      );
    }

    const categoryNameOf = new Map(categories.map((category) => [category.id, category.name]));

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

    // One unit of the shared daily AI budget, taken only when the provider is about to be called.
    const quotaResponse = await enforceAiQuota(session.user);
    if (quotaResponse) return quotaResponse;

    const {
      products: parsedProducts,
      invalid: invalidEntries,
      promptVersion,
      model,
    } = await parseShoppingListText({
      apiKey,
      text,
      categories,
      catalog: promptCatalog,
    });

    if (!Array.isArray(parsedProducts) || parsedProducts.length === 0) {
      return NextResponse.json(
        { error: 'No products found in text', parsedData: parsedProducts },
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
      results.failed.push(failedEntry(entry, 'Unrecognized entry in the AI response'));
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
        let dbProduct: { id: string; name: string; categoryId: string } | null =
          findCatalogMatch(product);

        // A category is needed only to create a missing product.
        if (!dbProduct) {
          if (!nameRu || !nameEn || !product.categoryName.trim()) {
            results.failed.push(
              failedEntry(
                product,
                product.existingProductId
                  ? 'Unknown product reference'
                  : 'Unrecognized entry in the AI response'
              )
            );
            continue;
          }

          const category = findCategory(categories, product.categoryName);

          if (!category) {
            results.failed.push(
              failedEntry(product, `Category "${product.categoryName}" not found`)
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
            name: dbProduct.name,
            category: category.name,
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
          name: dbProduct.name,
          category: categoryNameOf.get(dbProduct.categoryId) ?? '',
          note,
        });
      } catch (error) {
        results.failed.push(
          failedEntry(product, error instanceof Error ? error.message : 'Unknown error')
        );
      }
    }

    return NextResponse.json({
      message: `Import completed: ${results.added.length} items added, ${results.created.length} products created, ${results.skipped.length} skipped, ${results.failed.length} failed`,
      promptVersion,
      model,
      results,
    });
  } catch (error) {
    console.error('Error importing list:', error);
    return NextResponse.json({ error: 'Failed to import list' }, { status: 500 });
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
