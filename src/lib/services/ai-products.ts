import { GoogleGenAI } from '@google/genai';

export const AI_PRODUCTS_PROMPT_VERSION = 'ai-products-v1';
const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';

export type ProductCategory = {
  id: string;
  name: string;
  nameEn: string;
  order?: number;
};

export type SmartProductResult = {
  nameRu: string;
  nameEn: string;
  categoryName: string;
  emoji: string;
  needsCustomEmoji: boolean;
  reasoning?: string;
};

export type ProcessedProduct = {
  nameRu: string;
  nameEn: string;
  categoryName: string;
  emoji: string;
};

export type ParsedShoppingListProduct = ProcessedProduct & {
  note?: string;
};

function stripJsonMarkdown(responseText: string) {
  let json = responseText.trim();
  if (json.startsWith('```json')) {
    json = json
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
  } else if (json.startsWith('```')) {
    json = json.replace(/```\n?/g, '').trim();
  }

  return json.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ' ');
}

function assertString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseJson(responseText: string) {
  if (!assertString(responseText)) {
    throw new Error('AI response is empty');
  }

  return JSON.parse(stripJsonMarkdown(responseText));
}

export function parseSmartProductResponse(responseText: string): SmartProductResult {
  const parsed = parseJson(responseText) as Partial<SmartProductResult>;

  if (
    !assertString(parsed.nameRu) ||
    !assertString(parsed.nameEn) ||
    !assertString(parsed.categoryName) ||
    !assertString(parsed.emoji) ||
    typeof parsed.needsCustomEmoji !== 'boolean'
  ) {
    throw new Error('Invalid smart product AI response');
  }

  return {
    nameRu: parsed.nameRu,
    nameEn: parsed.nameEn,
    categoryName: parsed.categoryName,
    emoji: parsed.emoji,
    needsCustomEmoji: parsed.needsCustomEmoji,
    ...(assertString(parsed.reasoning) ? { reasoning: parsed.reasoning } : {}),
  };
}

function isProcessedProduct(value: unknown): value is ProcessedProduct {
  const product = value as Partial<ProcessedProduct>;
  return (
    !!product &&
    assertString(product.nameRu) &&
    assertString(product.nameEn) &&
    assertString(product.categoryName) &&
    typeof product.emoji === 'string'
  );
}

export function parseProcessedProductsResponse(responseText: string): ProcessedProduct[] {
  const parsed = parseJson(responseText);
  if (!Array.isArray(parsed) || !parsed.every(isProcessedProduct)) {
    throw new Error('Invalid bulk product AI response');
  }
  return parsed;
}

export function parseShoppingListResponse(responseText: string): ParsedShoppingListProduct[] {
  const products = parseProcessedProductsResponse(responseText);
  return products.map((product) => ({
    ...product,
    note: assertString((product as ParsedShoppingListProduct).note)
      ? (product as ParsedShoppingListProduct).note
      : undefined,
  }));
}

function categoriesPrompt(categories: ProductCategory[]) {
  return categories.map((category) => `${category.nameEn} (${category.name})`).join(', ');
}

export function buildSmartProductPrompt({
  productName,
  categoryId,
  categories,
}: {
  productName: string;
  categoryId?: string;
  categories: ProductCategory[];
}) {
  return `Prompt version: ${AI_PRODUCTS_PROMPT_VERSION}
You are a grocery product categorization assistant. Analyze the following product name and provide structured information.

Available categories: ${categoriesPrompt(categories)}

Product name: "${productName}"
${categoryId ? `Suggested category ID: ${categoryId}` : ''}

Tasks:
1. Translate the product name to Russian (nameRu) and English (nameEn)
2. Assign it to the MOST appropriate category from the available list
3. Suggest a single Unicode emoji that represents this product
4. Determine if a custom AI-generated emoji would be better (needsCustomEmoji: true/false)

IMPORTANT: Be generous with custom emoji - when in doubt, use custom.

Set needsCustomEmoji to TRUE for brand names, specific varieties, specialized prepared foods,
specific baby/kids brand items, missing exact Unicode emoji, or generic Unicode emoji that is not
distinctive enough.

Set needsCustomEmoji to FALSE for generic common products with a perfect distinctive Unicode emoji.

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
}

export function buildBulkProductsPrompt({
  productNames,
  categories,
}: {
  productNames: string[];
  categories: ProductCategory[];
}) {
  return `Prompt version: ${AI_PRODUCTS_PROMPT_VERSION}
You are a grocery categorization assistant. Given a list of product names, translate them to Russian and English, assign them to the most appropriate category, and suggest a Unicode emoji if one exists.

Available categories: ${categoriesPrompt(categories)}

Rules:
1. Translate each product name to both Russian (nameRu) and English (nameEn)
2. Assign each product to the MOST appropriate category from the list above
3. Suggest a single Unicode emoji that represents the product
4. If NO suitable emoji exists, use an empty string ""
5. Be precise with categories - use exact names from the list

Input products:
${productNames.map((name, index) => `${index + 1}. ${name}`).join('\n')}

Respond ONLY with valid JSON array in this exact format:
[
  {
    "nameRu": "Яблоко",
    "nameEn": "Apple",
    "categoryName": "Fruits",
    "emoji": "🍎"
  }
]`;
}

export function buildShoppingListPrompt({
  text,
  categories,
}: {
  text: string;
  categories: ProductCategory[];
}) {
  return `Prompt version: ${AI_PRODUCTS_PROMPT_VERSION}
You are a shopping list parser. Parse the following shopping list text into structured product data.

Available categories: ${categoriesPrompt(categories)}

Shopping list text:
"""
${text}
"""

Tasks:
1. Extract each product from the text
2. Translate each product to Russian (nameRu) and English (nameEn)
3. Assign each product to the most appropriate category
4. Suggest a Unicode emoji
5. Extract quantities or attributes into a separate optional note field

Rules:
- Use exact category names from the list
- Be precise with translations
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
}

async function generateText({ apiKey, prompt }: { apiKey: string; prompt: string }) {
  const genAI = new GoogleGenAI({ apiKey });
  const result = await genAI.models.generateContent({
    model: DEFAULT_TEXT_MODEL,
    contents: prompt,
  });

  if (!result.text) {
    throw new Error('No response from AI');
  }

  return result.text;
}

export async function analyzeSmartProduct({
  apiKey,
  productName,
  categoryId,
  categories,
}: {
  apiKey: string;
  productName: string;
  categoryId?: string;
  categories: ProductCategory[];
}) {
  const prompt = buildSmartProductPrompt({ productName, categoryId, categories });
  const responseText = await generateText({ apiKey, prompt });
  return {
    result: parseSmartProductResponse(responseText),
    promptVersion: AI_PRODUCTS_PROMPT_VERSION,
    model: DEFAULT_TEXT_MODEL,
  };
}

export async function processProductBatch({
  apiKey,
  productNames,
  categories,
}: {
  apiKey: string;
  productNames: string[];
  categories: ProductCategory[];
}) {
  const prompt = buildBulkProductsPrompt({ productNames, categories });
  const responseText = await generateText({ apiKey, prompt });
  return {
    products: parseProcessedProductsResponse(responseText),
    promptVersion: AI_PRODUCTS_PROMPT_VERSION,
    model: DEFAULT_TEXT_MODEL,
  };
}

export async function parseShoppingListText({
  apiKey,
  text,
  categories,
}: {
  apiKey: string;
  text: string;
  categories: ProductCategory[];
}) {
  const prompt = buildShoppingListPrompt({ text, categories });
  const responseText = await generateText({ apiKey, prompt });
  return {
    products: parseShoppingListResponse(responseText),
    promptVersion: AI_PRODUCTS_PROMPT_VERSION,
    model: DEFAULT_TEXT_MODEL,
  };
}
