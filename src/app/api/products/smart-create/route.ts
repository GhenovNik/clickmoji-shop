import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { visibleProductsWhere } from '@/lib/product-visibility';
import {
  checkRateLimit,
  getRequestLocale,
  getServerTranslator,
  rateLimitResponse,
} from '@/lib/auth-security';
import { enforceAiQuota } from '@/lib/ai-quota';
import { runTextAiCall } from '@/lib/text-ai-call';
import { textAiErrorCode } from '@/lib/services/text-ai-errors';
import { analyzeSmartProduct } from '@/lib/services/ai-products';
import { generateAndUploadEmojiAsset } from '@/lib/services/emoji-assets';
import { recordEmojiLibraryItem } from '@/lib/services/emoji-library';
import { summarizeEmojiGenerationFailure } from '@/lib/services/emoji-errors';

export const maxDuration = 60;

export async function POST(request: Request) {
  const locale = getRequestLocale(request);
  const t = getServerTranslator(locale);
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const dbUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, role: true, createdProductsCount: true },
    });

    if (!dbUser) {
      return NextResponse.json({ error: t('api.products.userNotFound') }, { status: 404 });
    }

    const GENERATION_LIMIT = 10;
    if (dbUser.role !== 'ADMIN' && dbUser.createdProductsCount >= GENERATION_LIMIT) {
      return NextResponse.json(
        { error: t('api.products.creationLimitReached', { limit: GENERATION_LIMIT }) },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { productName, categoryId } = body;

    if (!productName) {
      return NextResponse.json({ error: t('api.products.nameRequired') }, { status: 400 });
    }

    const userLimit = await checkRateLimit({
      key: `ai:smart-create:${session.user.id}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.resetAt, locale);
    }

    // Check for API key
    const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: t('api.products.aiNotConfigured') }, { status: 500 });
    }

    // Fetch existing categories
    const categories = await prisma.category.findMany({
      select: { id: true, name: true, nameEn: true, order: true },
      orderBy: { order: 'asc' },
    });

    if (categories.length === 0) {
      return NextResponse.json({ error: t('api.products.noCategories') }, { status: 400 });
    }

    const analysis = await runTextAiCall(dbUser, locale, () =>
      analyzeSmartProduct({ apiKey, productName, categoryId, categories })
    );
    if (analysis instanceof Response) return analysis;
    const { result: aiResult, promptVersion, model } = analysis;

    // Find the category
    const category = categories.find(
      (c) =>
        c.nameEn === aiResult.categoryName ||
        c.name === aiResult.categoryName ||
        c.id === categoryId
    );

    if (!category) {
      return NextResponse.json(
        {
          error: t('api.products.categoryNotFound', { category: aiResult.categoryName }),
          aiSuggestion: aiResult,
        },
        { status: 400 }
      );
    }

    // Check if a product visible to this user already exists; another user's private product
    // must not be returned (it would leak its id and creator).
    const existingProduct = await prisma.product.findFirst({
      where: {
        AND: [
          visibleProductsWhere(dbUser.id),
          {
            OR: [
              { name: aiResult.nameRu },
              { nameEn: aiResult.nameEn },
              { name: productName },
              { nameEn: productName },
            ],
          },
        ],
      },
      include: {
        category: true,
      },
    });

    if (existingProduct) {
      return NextResponse.json({
        exists: true,
        product: existingProduct,
        promptVersion,
        model,
        message: t('api.products.alreadyExists'),
      });
    }

    // Generate custom emoji if AI suggests it
    let customEmojiUrl: string | null = null;
    let isCustom = false;
    let finalEmoji = aiResult.emoji || '📦';

    // The image is a second paid call with its own unit; without one the product keeps the
    // Unicode emoji, like after a failed generation.
    if (aiResult.needsCustomEmoji && !(await enforceAiQuota(dbUser, locale))) {
      try {
        const emojiAsset = await generateAndUploadEmojiAsset({
          productName: aiResult.nameRu,
        });
        customEmojiUrl = emojiAsset.imageUrl;
        isCustom = true;
        // Only catalogue pictures go to the library; a user's personal product stays private.
        if (dbUser.role === 'ADMIN') {
          await recordEmojiLibraryItem({
            imageUrl: emojiAsset.imageUrl,
            name: aiResult.nameRu,
            nameEn: aiResult.nameEn,
            source: 'generated',
          });
        }
        finalEmoji = aiResult.emoji || '🎨';
      } catch (error) {
        // FR-10: the log carries allowlisted fields only, never the SDK message, body or cause.
        console.error('Error generating custom emoji:', summarizeEmojiGenerationFailure(error));
        // Continue with Unicode emoji if generation fails
      }
    }

    const isGlobal = dbUser.role === 'ADMIN';

    // Create the product
    const newProduct = await prisma.product.create({
      data: {
        name: aiResult.nameRu,
        nameEn: aiResult.nameEn,
        emoji: finalEmoji,
        categoryId: category.id,
        isCustom: isCustom,
        imageUrl: customEmojiUrl,
        isGlobal: isGlobal,
        createdById: dbUser.id,
      },
      include: {
        category: true,
      },
    });

    if (dbUser.role !== 'ADMIN') {
      await prisma.user.update({
        where: { id: dbUser.id },
        data: { createdProductsCount: { increment: 1 } },
      });
    }

    return NextResponse.json({
      product: newProduct,
      aiSuggestion: aiResult,
      needsCustomEmoji: aiResult.needsCustomEmoji,
      customEmojiGenerated: isCustom,
      promptVersion,
      model,
      message: t('api.products.created'),
    });
  } catch (error) {
    console.error('Error in smart product creation:', textAiErrorCode(error));
    return NextResponse.json({ error: t('api.products.createFailed') }, { status: 500 });
  }
}
