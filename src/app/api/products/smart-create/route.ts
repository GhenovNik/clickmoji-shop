import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { GoogleGenAI } from '@google/genai';

interface SmartProductResult {
  nameRu: string;
  nameEn: string;
  categoryId: string;
  categoryName: string;
  emoji: string;
  needsCustomEmoji: boolean;
}

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const body = await request.json();
    const { productName, categoryId } = body;

    if (!productName) {
      return NextResponse.json({ error: 'Product name is required' }, { status: 400 });
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

    // Create prompt for smart product creation
    const categoriesStr = categories.map((c) => `${c.nameEn} (${c.name})`).join(', ');

    const prompt = `You are a grocery product categorization assistant. Analyze the following product name and provide structured information.

Available categories: ${categoriesStr}

Product name: "${productName}"
${categoryId ? `Suggested category ID: ${categoryId}` : ''}

Tasks:
1. Translate the product name to Russian (nameRu) and English (nameEn)
2. Assign it to the MOST appropriate category from the available list
3. Suggest a single Unicode emoji that represents this product
4. Determine if a custom AI-generated emoji would be better (needsCustomEmoji: true/false)

   IMPORTANT: Be generous with custom emoji - when in doubt, use custom!

   - Set needsCustomEmoji to TRUE if:
     * The product has a BRAND NAME (e.g., "Lil' Crunchies", "Cheerios", "Huggies")
     * The product is a specific variety/breed (e.g., "карп", "сазан", "семга", "камамбер")
     * The product is a specialized prepared food (e.g., "тирамису", "суши", "хинкали")
     * The product is a specific baby/kids brand item (e.g., "Gerber пюре", "Lil' Crunchies")
     * No perfect Unicode emoji exists that specifically represents this product
     * The Unicode emoji would be too generic and not distinctive
     * Examples that NEED custom:
       - "Lil' Crunchies палочки" → branded baby snack, needs custom
       - "Carp" (карп) → specific fish type, needs custom
       - "Camembert" → specific cheese variety, needs custom
       - "Tiramisu" → specific dessert, needs custom

   - Set needsCustomEmoji to FALSE if:
     * Generic common product (e.g., "молоко", "хлеб", "яблоко", "рыба")
     * Perfect Unicode emoji exists and is distinctive enough
     * Not a branded or specialized item
     * Examples that DON'T need custom:
       - "Fish" (рыба) 🐟 → generic category, Unicode perfect
       - "Apple" (яблоко) 🍎 → common fruit, Unicode perfect
       - "Bread" (хлеб) 🍞 → generic bread, Unicode perfect
       - "Milk" (молоко) 🥛 → generic dairy, Unicode perfect

Rules:
- Use exact category names from the list
- Be precise with translations
- Choose the simplest, most recognizable emoji
- If suggesting a category, explain why briefly

Respond ONLY with valid JSON in this exact format:
{
  "nameRu": "Манго",
  "nameEn": "Mango",
  "categoryName": "Fruits",
  "emoji": "🥭",
  "needsCustomEmoji": false,
  "reasoning": "Mango has a perfect Unicode emoji and belongs to Fruits category"
}`;

    console.log('🤖 Analyzing product with Gemini AI:', productName);

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

    const aiResult = JSON.parse(jsonStr);

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
        message: 'Product already exists',
      });
    }

    // Generate custom emoji if AI suggests it
    let customEmojiUrl: string | null = null;
    let isCustom = false;
    let finalEmoji = aiResult.emoji || '📦';

    if (aiResult.needsCustomEmoji) {
      console.log('🎨 AI suggests custom emoji, generating...');
      try {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

        // Step 1: Generate emoji (получаем base64)
        const generateResponse = await fetch(`${baseUrl}/api/emoji/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: request.headers.get('cookie') || '',
          },
          body: JSON.stringify({ productName: aiResult.nameRu }),
        });

        if (generateResponse.ok) {
          const generateData = await generateResponse.json();

          // Step 2: Upload to UploadThing (только финальная версия)
          const uploadResponse = await fetch(`${baseUrl}/api/emoji/upload`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: request.headers.get('cookie') || '',
            },
            body: JSON.stringify({
              base64: generateData.base64,
              productName: aiResult.nameRu,
            }),
          });

          if (uploadResponse.ok) {
            const uploadData = await uploadResponse.json();
            customEmojiUrl = uploadData.imageUrl;
            isCustom = true;
            finalEmoji = aiResult.emoji || '🎨';
            console.log('✅ Custom emoji generated and uploaded:', customEmojiUrl);
          } else {
            console.warn('⚠️ Custom emoji upload failed, using Unicode emoji');
          }
        } else {
          console.warn('⚠️ Custom emoji generation failed, using Unicode emoji');
        }
      } catch (error) {
        console.error('❌ Error generating custom emoji:', error);
        // Continue with Unicode emoji if generation fails
      }
    }

    // Create the product
    const newProduct = await prisma.product.create({
      data: {
        name: aiResult.nameRu,
        nameEn: aiResult.nameEn,
        emoji: finalEmoji,
        categoryId: category.id,
        isCustom: isCustom,
        imageUrl: customEmojiUrl,
      },
      include: {
        category: true,
      },
    });

    console.log(
      `✅ Smart product created: ${newProduct.name} ${isCustom ? '(with custom emoji)' : ''}`
    );

    return NextResponse.json({
      product: newProduct,
      aiSuggestion: aiResult,
      needsCustomEmoji: aiResult.needsCustomEmoji,
      customEmojiGenerated: isCustom,
      message: 'Product created successfully',
    });
  } catch (error) {
    console.error('Error in smart product creation:', error);
    return NextResponse.json(
      {
        error: 'Failed to create product',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
