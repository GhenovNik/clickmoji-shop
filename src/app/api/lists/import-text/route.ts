import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
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

    const {
      products: parsedProducts,
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
      failed: [] as Array<{ product: ParsedShoppingListProduct; reason: string }>,
    };

    for (const product of parsedProducts) {
      try {
        // Find category
        const category = categories.find(
          (c) => c.nameEn === product.categoryName || c.name === product.categoryName
        );

        if (!category) {
          results.failed.push({
            product,
            reason: `Category "${product.categoryName}" not found`,
          });
          continue;
        }

        // Check if product exists in database
        let dbProduct = await prisma.product.findFirst({
          where: {
            OR: [{ name: product.nameRu }, { nameEn: product.nameEn }],
          },
        });

        // If product doesn't exist, create it
        if (!dbProduct) {
          dbProduct = await prisma.product.create({
            data: {
              name: product.nameRu,
              nameEn: product.nameEn,
              emoji: product.emoji || '📦',
              categoryId: category.id,
              isCustom: false,
              imageUrl: null,
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
          category: category.name,
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
