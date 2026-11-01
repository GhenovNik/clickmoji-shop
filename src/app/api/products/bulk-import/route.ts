import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { localizedName } from '@/lib/catalog-name';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { checkRateLimit, getRequestLocale, rateLimitResponse } from '@/lib/auth-security';
import { enforceAiQuota } from '@/lib/ai-quota';
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
        { error: await apiText(request, 'productNamesRequired') },
        { status: 400 }
      );
    }

    const userLimit = await checkRateLimit({
      key: `ai:bulk-import:${session.user.id}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.resetAt, getRequestLocale(request));
    }

    // Check for API key
    const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: await apiText(request, 'aiNotConfigured') },
        { status: 500 }
      );
    }

    // Fetch existing categories
    const categories = await prisma.category.findMany({
      select: { id: true, name: true, nameEn: true },
    });

    if (categories.length === 0) {
      return NextResponse.json(
        { error: await apiText(request, 'noCategoriesCreateFirst') },
        { status: 400 }
      );
    }

    // One unit of the administrator's daily AI budget for the batch analysis (one provider call).
    const quotaResponse = await enforceAiQuota(session.user, getRequestLocale(request));
    if (quotaResponse) return quotaResponse;

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
          reason: await apiText(request, 'importCategoryNotFound', {
            category: product.categoryName,
          }),
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
          reason: await apiText(request, 'importProductExists'),
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
          // The report is read in the interface language, like the import-text report.
          category: localizedName(category, getRequestLocale(request)),
        });
      } catch (error) {
        // The raw error stays in the server log; the report gets a translated reason.
        console.error('Error importing a product:', error);
        results.failed.push({
          product,
          reason: await apiText(request, 'importEntryFailed'),
        });
      }
    }

    return NextResponse.json({
      message: await apiText(request, 'bulkImportSummary', {
        success: results.success.length,
        skipped: results.skipped.length,
        failed: results.failed.length,
      }),
      promptVersion,
      model,
      results,
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return NextResponse.json(
      { error: await apiText(request, 'importProductsFailed') },
      { status: 500 }
    );
  }
}
