/**
 * Bulk Product Import Script
 *
 * Usage:
 *   1. Create a file scripts/products-input.json with an array of product names
 *   2. Run: tsx scripts/import-products.ts
 *
 * The script will:
 *   - Use Gemini AI to translate product names to Russian and English
 *   - Automatically categorize products based on existing categories
 *   - Leave emoji field empty if no suitable emoji found
 *   - Insert products into the database
 */

import { PrismaClient } from '@prisma/client';
import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

interface ProductInput {
  name: string; // Can be in any language
}

interface ProcessedProduct {
  nameRu: string;
  nameEn: string;
  categoryId: string;
  categoryName: string;
  emoji: string;
}

async function main() {
  console.log('📦 Starting bulk product import...\n');

  // Check for API key
  const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ GOOGLE_GENAI_API_KEY or GEMINI_API_KEY not found in environment variables');
    process.exit(1);
  }

  // Read input file
  const inputPath = join(process.cwd(), 'scripts', 'products-input.json');
  let productNames: string[];

  try {
    const rawData = readFileSync(inputPath, 'utf-8');
    productNames = JSON.parse(rawData);

    if (!Array.isArray(productNames)) {
      console.error('❌ products-input.json must contain an array of product names');
      process.exit(1);
    }

    console.log(`📝 Found ${productNames.length} products to import\n`);
  } catch (error) {
    console.error('❌ Failed to read products-input.json');
    console.error('   Create the file with format: ["product1", "product2", ...]');
    process.exit(1);
  }

  // Fetch existing categories
  const categories = await prisma.category.findMany({
    select: { id: true, name: true, nameEn: true },
  });

  if (categories.length === 0) {
    console.error('❌ No categories found in database. Please run seed first: npx prisma db seed');
    process.exit(1);
  }

  console.log(`📚 Found ${categories.length} categories in database\n`);

  // Initialize Gemini
  const genAI = new GoogleGenAI({ apiKey });
  const model = genAI.models.generateContent;

  // Create prompt for batch processing
  const categoriesStr = categories.map(c => `${c.nameEn} (${c.name})`).join(', ');

  const prompt = `You are a grocery categorization assistant. Given a list of product names, translate them to Russian and English, assign them to the most appropriate category, and suggest a Unicode emoji if one exists.

Available categories: ${categoriesStr}

Rules:
1. Translate each product name to both Russian (nameRu) and English (nameEn)
2. Assign each product to the MOST appropriate category from the list above
3. Suggest a single Unicode emoji that represents the product (e.g., 🍎 for apple)
4. If NO suitable emoji exists, use an empty string ""
5. Be precise with categories - use exact names from the list

Input products:
${productNames.map((name, i) => `${i + 1}. ${name}`).join('\n')}

Respond ONLY with valid JSON array in this exact format:
[
  {
    "nameRu": "Яблоко",
    "nameEn": "Apple",
    "categoryName": "Fruits",
    "emoji": "🍎"
  }
]`;

  console.log('🤖 Processing products with Gemini AI...\n');

  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-2.0-flash-exp',
      contents: prompt,
    });
    const responseText = result.text;

    if (!responseText) {
      throw new Error('No response from AI');
    }

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```\n?/g, '').trim();
    }

    // Clean control characters that might break JSON parsing
    // Replace control characters (except \n, \r, \t) with space
    jsonStr = jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ' ');

    const processedProducts: ProcessedProduct[] = JSON.parse(jsonStr);

    console.log(`✅ AI processed ${processedProducts.length} products\n`);

    // Match categories and insert products
    let successCount = 0;
    let skipCount = 0;

    for (const product of processedProducts) {
      const category = categories.find(
        c => c.nameEn === product.categoryName || c.name === product.categoryName
      );

      if (!category) {
        console.warn(`⚠️  Skipping "${product.nameRu}" - category "${product.categoryName}" not found`);
        skipCount++;
        continue;
      }

      // Check if product already exists (by name or nameEn)
      const existingProduct = await prisma.product.findFirst({
        where: {
          OR: [
            { name: product.nameRu },
            { nameEn: product.nameEn },
          ],
        },
      });

      if (existingProduct) {
        console.log(`  ⏭️  ${product.nameRu} (${product.nameEn}) - already exists, skipping`);
        skipCount++;
        continue;
      }

      try {
        await prisma.product.create({
          data: {
            name: product.nameRu,
            nameEn: product.nameEn,
            emoji: product.emoji || '📦', // Default to box emoji if empty
            categoryId: category.id,
            isCustom: false,
            imageUrl: null,
          },
        });

        const emojiDisplay = product.emoji || '❌';
        console.log(`  ✅ ${emojiDisplay} ${product.nameRu} (${product.nameEn}) → ${category.name}`);
        successCount++;
      } catch (error) {
        console.error(`  ❌ Failed to create "${product.nameRu}":`, error);
        skipCount++;
      }
    }

    console.log('\n🎉 Import completed!');
    console.log(`   ✅ Successfully imported: ${successCount}`);
    if (skipCount > 0) {
      console.log(`   ⚠️  Skipped: ${skipCount}`);
    }

  } catch (error) {
    console.error('❌ Failed to process products with AI:', error);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error('❌ Fatal error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
