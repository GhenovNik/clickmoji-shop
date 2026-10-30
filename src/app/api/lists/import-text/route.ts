import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { visibleProductsWhere } from '@/lib/product-visibility';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
import { enforceAiQuota } from '@/lib/ai-quota';
import { parseShoppingListText, type ParsedShoppingListProduct } from '@/lib/services/ai-products';

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
      failed: [] as Array<{ product: Partial<ParsedShoppingListProduct>; reason: string }>,
    };

    for (const entry of invalidEntries) {
      results.failed.push({
        product: (entry && typeof entry === 'object' ? entry : {}) as ParsedShoppingListProduct,
        reason: 'Unrecognized entry in the AI response',
      });
    }

    const categoryNameOf = new Map(categories.map((c) => [c.id, c.name]));

    for (const product of parsedProducts) {
      try {
        const nameRu = product.nameRu.trim();
        const nameEn = product.nameEn.trim();

        // An existing product the user can see is reused whatever category the model chose, and
        // regardless of letter case or surrounding spaces; another user's private product is
        // never matched. Exact matches win over case-insensitive ones, then the oldest product.
        const candidates = await prisma.product.findMany({
          where: {
            AND: [
              visibleProductsWhere(session.user.id),
              {
                OR: [
                  { name: { equals: nameRu, mode: 'insensitive' } },
                  { nameEn: { equals: nameEn, mode: 'insensitive' } },
                ],
              },
            ],
          },
          orderBy: { createdAt: 'asc' },
          take: 10,
        });
        let dbProduct =
          candidates.find((c) => c.name === nameRu) ??
          candidates.find((c) => c.nameEn === nameEn) ??
          candidates[0] ??
          null;

        // A category is needed only to create a missing product.
        if (!dbProduct) {
          const category = findCategory(categories, product.categoryName);

          if (!category) {
            results.failed.push({
              product,
              reason: `Category "${product.categoryName}" not found`,
            });
            continue;
          }

          // A missing product is created like in smart-create: private to a regular user and
          // global only when an administrator imports it.
          dbProduct = await prisma.product.create({
            data: {
              name: nameRu,
              nameEn,
              emoji: product.emoji || '📦',
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
            note: product.note,
          });
        }

        // Add to list (duplicates are now allowed)
        await prisma.item.create({
          data: {
            listId: listId,
            productId: dbProduct.id,
            note: product.note || null,
            isPurchased: false,
          },
        });

        results.added.push({
          name: dbProduct.name,
          category: categoryNameOf.get(dbProduct.categoryId) ?? '',
          note: product.note,
        });
      } catch (error) {
        results.failed.push({
          product,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
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

// The prompt lists categories as "Dairy (<Russian name>)" and asks for exact names; accept the
// English name, the Russian name or that listed form, ignoring case and surrounding spaces.
function findCategory<T extends { name: string; nameEn: string }>(
  categories: T[],
  categoryName: string
): T | undefined {
  const wanted = normalized(categoryName);
  return categories.find((c) =>
    [c.nameEn, c.name, `${c.nameEn} (${c.name})`].some((form) => normalized(form) === wanted)
  );
}
