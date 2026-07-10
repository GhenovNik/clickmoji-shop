import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
import { processProductBatch, type ProcessedProduct } from '@/lib/services/ai-products';

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const body = await request.json();
    const { productNames } = body;

    if (!productNames || !Array.isArray(productNames) || productNames.length === 0) {
      return NextResponse.json(
        { error: 'productNames must be a non-empty array' },
        { status: 400 }
      );
    }

    const userLimit = await checkRateLimit({
      key: `ai:bulk-import:${session.user.id}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.resetAt);
    }

    // Check for API key
    const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'GOOGLE_GENAI_API_KEY or GEMINI_API_KEY not configured' },
        { status: 500 }
      );
    }

    // Fetch existing categories
    const categories = await prisma.category.findMany({
      select: { id: true, name: true, nameEn: true },
    });

    if (categories.length === 0) {
      return NextResponse.json(
        { error: 'No categories found. Please create categories first.' },
        { status: 400 }
      );
    }

    const {
      products: processedProducts,
      promptVersion,
      model,
    } = await processProductBatch({
      apiKey,
      productNames,
      categories,
    });

    // Match categories and insert products
    const results = {
      success: [] as Array<{
        id: string;
        name: string;
        nameEn: string;
        emoji: string;
        category: string;
      }>,
      failed: [] as Array<{ product: ProcessedProduct; reason: string }>,
      skipped: [] as Array<{ name: string; nameEn?: string; reason: string }>,
    };

    for (const product of processedProducts) {
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

      // Check if product already exists (by name or nameEn)
      const existingProduct = await prisma.product.findFirst({
        where: {
          OR: [{ name: product.nameRu }, { nameEn: product.nameEn }],
        },
      });

      if (existingProduct) {
        results.skipped.push({
          name: product.nameRu,
          nameEn: product.nameEn,
          reason: 'Product already exists',
        });
        continue;
      }

      try {
        const createdProduct = await prisma.product.create({
          data: {
            name: product.nameRu,
            nameEn: product.nameEn,
            emoji: product.emoji || '📦',
            categoryId: category.id,
            isCustom: false,
            imageUrl: null,
          },
        });

        results.success.push({
          id: createdProduct.id,
          name: createdProduct.name,
          nameEn: createdProduct.nameEn,
          emoji: createdProduct.emoji,
          category: category.name,
        });
      } catch (error) {
        results.failed.push({
          product,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      message: `Imported ${results.success.length} products, ${results.skipped.length} skipped (duplicates), ${results.failed.length} failed`,
      promptVersion,
      model,
      results,
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return NextResponse.json({ error: 'Failed to import products' }, { status: 500 });
  }
}
