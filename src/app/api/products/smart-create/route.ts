import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
import { analyzeSmartProduct } from '@/lib/services/ai-products';
import { generateAndUploadEmojiAsset } from '@/lib/services/emoji-assets';

export async function POST(request: Request) {
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const dbUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, role: true, createdProductsCount: true },
    });

    if (!dbUser) {
      return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });
    }

    const GENERATION_LIMIT = 10;
    if (dbUser.role !== 'ADMIN' && dbUser.createdProductsCount >= GENERATION_LIMIT) {
      return NextResponse.json(
        {
          error: `Вы исчерпали лимит создания своих товаров (${GENERATION_LIMIT}/${GENERATION_LIMIT}).`,
        },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { productName, categoryId } = body;

    if (!productName) {
      return NextResponse.json({ error: 'Product name is required' }, { status: 400 });
    }

    const userLimit = await checkRateLimit({
      key: `ai:smart-create:${session.user.id}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.resetAt);
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
      result: aiResult,
      promptVersion,
      model,
    } = await analyzeSmartProduct({
      apiKey,
      productName,
      categoryId,
      categories,
    });

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
          error: `Category "${aiResult.categoryName}" not found`,
          aiSuggestion: aiResult,
        },
        { status: 400 }
      );
    }

    // Check if product already exists
    const existingProduct = await prisma.product.findFirst({
      where: {
        OR: [
          { name: aiResult.nameRu },
          { nameEn: aiResult.nameEn },
          { name: productName },
          { nameEn: productName },
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
        message: 'Product already exists',
      });
    }

    // Generate custom emoji if AI suggests it
    let customEmojiUrl: string | null = null;
    let isCustom = false;
    let finalEmoji = aiResult.emoji || '📦';

    if (aiResult.needsCustomEmoji) {
      try {
        const emojiAsset = await generateAndUploadEmojiAsset({
          productName: aiResult.nameRu,
        });
        customEmojiUrl = emojiAsset.imageUrl;
        isCustom = true;
        finalEmoji = aiResult.emoji || '🎨';
      } catch (error) {
        console.error('Error generating custom emoji:', error);
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
      message: 'Product created successfully',
    });
  } catch (error) {
    console.error('Error in smart product creation:', error);
    return NextResponse.json({ error: 'Failed to create product' }, { status: 500 });
  }
}
