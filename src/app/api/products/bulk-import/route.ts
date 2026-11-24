import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import {
  AI_INPUT_LIMITS,
  AiInputTooLargeError,
  readBoundedJsonBody,
} from '@/lib/ai-input-validation';
import { estimateBulkProductsPromptTokens } from '@/lib/ai-pricing';
import { localizedName } from '@/lib/catalog-name';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { checkRateLimit, getRequestLocale, rateLimitResponse } from '@/lib/auth-security';
import { runTextAiCall } from '@/lib/text-ai-call';
import { textAiErrorCode } from '@/lib/services/text-ai-errors';
import { processProductBatch, type ProcessedProduct } from '@/lib/services/ai-products';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const locale = getRequestLocale(request);
    const parsedBody = await readBoundedJsonBody({
      request,
      maxBytes: AI_INPUT_LIMITS.BULK_IMPORT_BODY_MAX_BYTES,
      locale,
      namespace: 'errors',
    });
    if (!parsedBody.ok) return parsedBody.response;

    const { productNames: rawProductNames } = parsedBody.body;

    if (!rawProductNames || !Array.isArray(rawProductNames) || rawProductNames.length === 0) {
      return NextResponse.json(
        { error: await apiText(request, 'productNamesRequired') },
        { status: 400 }
      );
    }

    if (rawProductNames.length > AI_INPUT_LIMITS.MAX_BULK_IMPORT_ITEMS) {
      return NextResponse.json(
        {
          error: await apiText(request, 'bulkImportTooManyItems', {
            max: AI_INPUT_LIMITS.MAX_BULK_IMPORT_ITEMS,
          }),
        },
        { status: 400 }
      );
    }

    const productNames: string[] = [];
    let totalChars = 0;
    for (const item of rawProductNames) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        return NextResponse.json(
          { error: await apiText(request, 'productNamesRequired') },
          { status: 400 }
        );
      }
      const trimmed = item.trim();
      if (trimmed.length > AI_INPUT_LIMITS.MAX_PRODUCT_NAME_LENGTH) {
        return NextResponse.json(
          {
            error: await apiText(request, 'bulkImportNameTooLong', {
              max: AI_INPUT_LIMITS.MAX_PRODUCT_NAME_LENGTH,
            }),
          },
          { status: 400 }
        );
      }
      totalChars += trimmed.length;
      if (totalChars > AI_INPUT_LIMITS.MAX_BULK_IMPORT_TOTAL_CHARS) {
        return NextResponse.json(
          {
            error: await apiText(request, 'bulkImportTextTooLong', {
              max: AI_INPUT_LIMITS.MAX_BULK_IMPORT_TOTAL_CHARS,
            }),
          },
          { status: 400 }
        );
      }
      productNames.push(trimmed);
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

    const analysis = await runTextAiCall(
      session.user,
      getRequestLocale(request),
      () => processProductBatch({ apiKey, productNames, categories }),
      { maxPromptTokens: estimateBulkProductsPromptTokens({ productNames, categories }) }
    );
    if (analysis instanceof Response) return analysis;
    const { products: processedProducts, promptVersion, model } = analysis;

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
        // Log only an allowlisted code, never prompts or upstream error details.
        console.error('Error importing a product:', textAiErrorCode(error));
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
    if (error instanceof AiInputTooLargeError) {
      return NextResponse.json(
        { error: await apiText(request, 'payloadTooLarge') },
        { status: 413 }
      );
    }
    console.error('Error in bulk import:', textAiErrorCode(error));
    return NextResponse.json(
      { error: await apiText(request, 'importProductsFailed') },
      { status: 500 }
    );
  }
}
