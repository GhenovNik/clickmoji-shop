import { GoogleGenAI } from '@google/genai';
import { resolveGoogleTextModel } from '@/lib/services/google-text-model';

export const AI_PRODUCTS_PROMPT_VERSION = 'ai-products-v2';

export type ProductCategory = {
  id: string;
  name: string;
  nameEn: string;
  order?: number;
};

/** The compact view of a visible catalog product that the parser prompt can reference by id. */
export type CatalogProductPromptEntry = {
  id: string;
  name: string;
  nameEn: string;
  categoryName: string;
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

export type ParsedShoppingListProduct = {
  existingProductId?: string;
  nameRu: string;
  nameEn: string;
  categoryName: string;
  emoji: string;
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

// A parser entry is either a reference to a visible catalog product (`existingProductId`) or a
// complete new-product proposal. Fields that are absent are kept as empty strings so the route can
// still report the entry; it validates the id against the catalog and cleans the proposal.
function parseShoppingListEntry(value: unknown): ParsedShoppingListProduct | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const existingProductId = assertString(entry.existingProductId)
    ? entry.existingProductId.trim()
    : undefined;
  const nameRu = assertString(entry.nameRu) ? entry.nameRu.trim() : '';
  const nameEn = assertString(entry.nameEn) ? entry.nameEn.trim() : '';
  const categoryName = assertString(entry.categoryName) ? entry.categoryName.trim() : '';
  const emoji = typeof entry.emoji === 'string' ? entry.emoji.trim() : '';
  const note = assertString(entry.note) ? entry.note.trim() : undefined;

  const completeNewProduct =
    !!nameRu && !!nameEn && !!categoryName && typeof entry.emoji === 'string';
  if (!existingProductId && !completeNewProduct) return null;

  return {
    ...(existingProductId ? { existingProductId } : {}),
    nameRu,
    nameEn,
    categoryName,
    emoji,
    ...(note ? { note } : {}),
  };
}

// One unusable entry must not discard the rest of a pasted list: valid entries are returned and
// the others are reported back as `invalid`, so the route can list them as failed. A response
// that is not a JSON array is still an error.
export function parseShoppingListResponse(responseText: string): {
  products: ParsedShoppingListProduct[];
  invalid: unknown[];
} {
  const parsed = parseJson(responseText);
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid shopping list AI response');
  }
  const products: ParsedShoppingListProduct[] = [];
  const invalid: unknown[] = [];
  for (const entry of parsed) {
    const product = parseShoppingListEntry(entry);
    if (product) products.push(product);
    else invalid.push(entry);
  }
  return { products, invalid };
}

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/dairy|молоч/i, 'milk, cream, sour cream, kefir, yogurt, cheese, butter, eggs'],
  [/bread|bakery|хлеб|выпеч/i, 'bread, rolls, pastry, flour'],
  [
    /pharm|аптек|health|здоров/i,
    'medicines, vitamins and personal care only; never food or drinks',
  ],
  [/meat|мяс/i, 'meat, poultry, sausage'],
  [/fish|рыб/i, 'fish and seafood'],
  [/vegetable|овощ|зелен/i, 'vegetables and greens'],
  [/fruit|фрукт|ягод/i, 'fruit and berries'],
  [/drink|beverage|напит/i, 'water, juice, soda, tea, coffee'],
  [/grocery|бакал|круп/i, 'grains, pasta, sugar, salt, oil, spices'],
  [/spice|спец|приправ/i, 'spices and seasoning'],
  [/frozen|замор/i, 'frozen food'],
  [/sweet|dessert|слад|кондитер/i, 'sweets, chocolate, desserts'],
  [/household|бытов|cleaning|хим/i, 'cleaning and household goods'],
  [/baby|дет/i, 'baby food and care'],
];

function categoryHint(category: ProductCategory) {
  const haystack = `${category.nameEn} ${category.name}`;
  return CATEGORY_HINTS.find(([pattern]) => pattern.test(haystack))?.[1];
}

function categoriesPrompt(categories: ProductCategory[]) {
  return categories
    .map((category) => {
      const hint = categoryHint(category);
      return `- ${category.nameEn} (${category.name})${hint ? ` — ${hint}` : ''}`;
    })
    .join('\n');
}

const compactField = (value: string) => value.replace(/\s+/g, ' ').trim();

function catalogPrompt(catalog: CatalogProductPromptEntry[]) {
  if (catalog.length === 0) return 'The visible catalog is empty.';
  const lines = catalog.map(
    (product) =>
      `- ${compactField(product.id)} | ${compactField(product.name)} | ${compactField(product.nameEn)} | ${compactField(product.categoryName)}`
  );
  return lines.join('\n');
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
1. Set nameRu to the shopper's own name, cleaned only: remove quantities, units and punctuation and capitalise the first letter. If the name is Russian, keep the Russian word(s) — never translate Russian to English and back. If it is not Russian, give its Russian name.
2. Set nameEn to the English product name; this field only.
3. Assign it to the MOST appropriate category from the available list; food and drinks never belong to a pharmacy category.
4. Suggest the closest single Unicode emoji by meaning (сметана, сливки, кефир -> 🥛; специи -> 🧂); never use the 📦 placeholder, return "" only if no emoji exists.
5. Determine if a custom AI-generated emoji would be better (needsCustomEmoji: true/false)

IMPORTANT: Be generous with custom emoji - when in doubt, use custom.

Set needsCustomEmoji to TRUE for brand names, specific varieties, specialized prepared foods,
specific baby/kids brand items, missing exact Unicode emoji, or generic Unicode emoji that is not
distinctive enough.

Set needsCustomEmoji to FALSE for generic common products with a perfect distinctive Unicode emoji.

Rules:
- Use exact category names from the list
- Do not rename or "correct" a name that is already Russian
- Choose the closest, most recognizable emoji
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
You are a grocery categorization assistant. Given a list of product names, assign each one to the most appropriate category and suggest a Unicode emoji if one exists.

Available categories:
${categoriesPrompt(categories)}

Rules:
1. nameRu is the shopper's own name, cleaned only: remove quantities, units and punctuation and capitalise the first letter. If the name is Russian, keep the Russian word(s) — never translate Russian to English and back. If it is not Russian, give its Russian name.
2. nameEn is the English product name; this field only.
3. Assign each product to the MOST appropriate category from the list above; food and drinks never belong to a pharmacy category.
4. Suggest the closest single Unicode emoji by meaning (сметана, сливки, кефир -> 🥛; специи -> 🧂); never use the 📦 placeholder. If NO suitable emoji exists, use an empty string ""
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
  catalog = [],
}: {
  text: string;
  categories: ProductCategory[];
  catalog?: CatalogProductPromptEntry[];
}) {
  return `Prompt version: ${AI_PRODUCTS_PROMPT_VERSION}
You are a shopping list parser. Parse the following shopping list text into structured product data.

Available categories (use the exact English name in categoryName):
${categoriesPrompt(categories)}

Catalog products visible to this shopper (id | Russian name | English name | category):
${catalogPrompt(catalog)}

Shopping list text:
"""
${text}
"""

Tasks:
1. Extract each product from the text; skip empty lines and non-product text, and combine duplicates.
2. If a line is the same product as a catalog entry above, return only that entry's id:
   { "existingProductId": "<id copied exactly from the catalog>", "note": "<quantity or attribute>" }
   Never invent an id and never rename or translate a catalog product.
3. Otherwise return a new product proposal:
   - nameRu: the shopper's own word(s), cleaned only — remove quantities, units and punctuation and capitalise the first letter. If the input is Russian, keep the Russian word(s): never translate them to English and back. If the input is not Russian, give its Russian name.
   - nameEn: the English product name; this field only.
   - categoryName: the exact English category name from the list above; food and drinks never belong to a pharmacy category.
   - emoji: the closest single Unicode emoji by meaning (сметана, сливки, кефир -> 🥛; специи -> 🧂). Never use the 📦 placeholder; return "" only if no emoji exists.
   - note: every quantity or attribute removed from the name ("20%", "2 шт", "1 л", "2L"), not part of nameRu.

Rules:
- Use exact category names from the list
- Do not translate, rename or "correct" a name that is already Russian
- Skip empty lines or non-product text
- Combine duplicate products

Respond ONLY with valid JSON array. Examples:
Existing catalog product:
[{ "existingProductId": "catalog-id", "note": "2 шт" }]
New product:
[{ "nameRu": "Сметана", "nameEn": "Sour cream", "categoryName": "Dairy", "emoji": "🥛", "note": "20%" }]`;
}

async function generateText({
  apiKey,
  prompt,
  model,
}: {
  apiKey: string;
  prompt: string;
  model: string;
}) {
  const genAI = new GoogleGenAI({ apiKey });
  const result = await genAI.models.generateContent({
    model,
    contents: prompt,
    config: { responseMimeType: 'application/json' },
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
  const model = resolveGoogleTextModel();
  const prompt = buildSmartProductPrompt({ productName, categoryId, categories });
  const responseText = await generateText({ apiKey, prompt, model });
  return {
    result: parseSmartProductResponse(responseText),
    promptVersion: AI_PRODUCTS_PROMPT_VERSION,
    model,
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
  const model = resolveGoogleTextModel();
  const prompt = buildBulkProductsPrompt({ productNames, categories });
  const responseText = await generateText({ apiKey, prompt, model });
  return {
    products: parseProcessedProductsResponse(responseText),
    promptVersion: AI_PRODUCTS_PROMPT_VERSION,
    model,
  };
}

export async function parseShoppingListText({
  apiKey,
  text,
  categories,
  catalog = [],
}: {
  apiKey: string;
  text: string;
  categories: ProductCategory[];
  catalog?: CatalogProductPromptEntry[];
}) {
  const model = resolveGoogleTextModel();
  const prompt = buildShoppingListPrompt({ text, categories, catalog });
  const responseText = await generateText({ apiKey, prompt, model });
  return {
    ...parseShoppingListResponse(responseText),
    promptVersion: AI_PRODUCTS_PROMPT_VERSION,
    model,
  };
}
