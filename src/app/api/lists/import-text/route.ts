import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { GoogleGenAI } from '@google/genai';

interface ParsedProduct {
  nameRu: string;
  nameEn: string;
  categoryName: string;
  emoji: string;
  note?: string;
}

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

    if (!listId) {
      return NextResponse.json({ error: 'List ID is required' }, { status: 400 });
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

    // Initialize Gemini
    const genAI = new GoogleGenAI({ apiKey });

    // Create prompt for parsing shopping list
    const categoriesStr = categories.map((c) => `${c.nameEn} (${c.name})`).join(', ');

    const prompt = `You are a shopping list parser. Parse the following shopping list text into structured product data.

Available categories: ${categoriesStr}

Shopping list text:
"""
${text}
"""

Tasks:
1. Extract each product from the text (handle various formats: bullet points, numbers, commas, newlines)
2. For each product:
   - Translate to Russian (nameRu) and English (nameEn)
   - Assign to the most appropriate category
   - Suggest a Unicode emoji
   - Extract any notes/quantities (e.g., "2 kg", "red", "large") into a separate "note" field
3. Handle common shopping list patterns:
   - "Milk 2L" → nameRu: "Молоко", note: "2L"
   - "Red apples" → nameRu: "Яблоки", note: "красные"
   - "Bread (whole grain)" → nameRu: "Хлеб", note: "цельнозерновой"

Rules:
- Use exact category names from the list
- Be precise with translations
- Extract quantities and attributes into notes
- Skip empty lines or non-product text
- Combine duplicate products

Respond ONLY with valid JSON array:
[
  {
    "nameRu": "Молоко",
    "nameEn": "Milk",
    "categoryName": "Dairy",
    "emoji": "🥛",
    "note": "2L"
  }
]`;

    console.log('🤖 Parsing shopping list with Gemini AI...');

    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    const responseText = result.text;

    if (!responseText) {
      return NextResponse.json({ error: 'No response from AI' }, { status: 500 });
    }

    // Extract JSON from response
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```\n?/g, '').trim();
    }

    // Clean control characters
    jsonStr = jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ' ');

    const parsedProducts: ParsedProduct[] = JSON.parse(jsonStr);

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
      failed: [] as Array<{ product: ParsedProduct; reason: string }>,
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

    console.log('✅ List import completed:', {
      added: results.added.length,
      created: results.created.length,
      skipped: results.skipped.length,
      failed: results.failed.length,
    });

    return NextResponse.json({
      message: `Import completed: ${results.added.length} items added, ${results.created.length} products created, ${results.skipped.length} skipped, ${results.failed.length} failed`,
      results,
    });
  } catch (error) {
    console.error('Error importing list:', error);
    return NextResponse.json(
      {
        error: 'Failed to import list',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
