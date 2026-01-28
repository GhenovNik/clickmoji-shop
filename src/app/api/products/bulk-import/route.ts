import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { GoogleGenAI } from '@google/genai';

interface ProcessedProduct {
  nameRu: string;
  nameEn: string;
  categoryName: string;
  emoji: string;
}

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const body = await request.json();
    const { productNames } = body;

    if (!productNames || !Array.isArray(productNames) || productNames.length === 0) {
      return NextResponse.json(
        { error: 'productNames must be a non-empty array' },
        { status: 400 }
      );
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

    // Initialize Gemini
    const genAI = new GoogleGenAI({ apiKey });

    // Create prompt for batch processing
    const categoriesStr = categories.map((c) => `${c.nameEn} (${c.name})`).join(', ');

    const prompt = `You are a grocery categorization assistant. Given a list of product names, translate them to Russian and English, assign them to the most appropriate category, and suggest a Unicode emoji if one exists.

Available categories: ${categoriesStr}

Rules:
1. Translate each product name to both Russian (nameRu) and English (nameEn)
2. Assign each product to the MOST appropriate category from the list above
3. Suggest a single Unicode emoji that represents the product (e.g., 🍎 for apple)
4. If NO suitable emoji exists, use an empty string ""
5. Be precise with categories - use exact names from the list

Input products:
${productNames.map((name: string, i: number) => `${i + 1}. ${name}`).join('\n')}

Respond ONLY with valid JSON array in this exact format:
[
  {
    "nameRu": "Яблоко",
    "nameEn": "Apple",
    "categoryName": "Fruits",
    "emoji": "🍎"
  }
]`;

    console.log('🤖 Processing products with Gemini AI...');

    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    const responseText = result.text;

    if (!responseText) {
      return NextResponse.json({ error: 'No response from AI' }, { status: 500 });
    }

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```\n?/g, '').trim();
    }

    // Clean control characters that might break JSON parsing
    // Replace control characters (except \n, \r, \t) with space
    jsonStr = jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ' ');

    const processedProducts: ProcessedProduct[] = JSON.parse(jsonStr);

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
      results,
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return NextResponse.json(
      {
        error: 'Failed to import products',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
