const QUANTITY_PATTERN =
  /(\d+(?:[.,]\d+)?)\s*(%|шт|штук[а-яё]*|литр[а-яё]*|л|мл|миллилитр[а-яё]*|кг|килограмм[а-яё]*|гр|грамм[а-яё]*|г|уп|упаков[а-яё]*|пачк[а-яё]*|бут[а-яё]*|бутыл[а-яё]*|стакан[а-яё]*|ложк[а-яё]*|pcs|pieces?|l|ml|kg|g|oz|lb)(?![а-яёa-z])/giu;

const PARENTHETICAL_PATTERN = /[([{]([^)\]}]+)[)\]}]/g;

const EMOJI_PATTERN =
  /^\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*$/u;

function collapse(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Key for comparing a shopper's product word with a catalog name: case and the Cyrillic yo/ye
 * letter do not matter, and quantities, units, numbers and punctuation are dropped, so a name with
 * a volume or a percentage added produces the same key as the bare catalog name.
 */
export function normalizeProductName(value: string): string {
  return collapse(
    value
      .toLocaleLowerCase('ru')
      .replace(/ё/g, 'е')
      .replace(QUANTITY_PATTERN, ' ')
      .replace(PARENTHETICAL_PATTERN, ' ')
      .replace(/\d+(?:[.,]\d+)?/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  );
}

/** The quantities and attributes of a line, kept in the order they were written. */
export function extractProductNote(value: string): string | undefined {
  const found = [...value.matchAll(QUANTITY_PATTERN)].map((match) => collapse(match[0]));
  for (const match of value.matchAll(PARENTHETICAL_PATTERN)) {
    found.push(collapse(match[1]));
  }
  const unique = [...new Set(found.filter(Boolean))];
  return unique.length > 0 ? unique.join(', ') : undefined;
}

/** The shopper's own word(s), cleaned and with the first letter capitalised. */
export function cleanProductName(value: string): string {
  const cleaned = collapse(
    value.replace(QUANTITY_PATTERN, ' ').replace(PARENTHETICAL_PATTERN, ' ')
  );
  if (!cleaned) return '';
  return cleaned.charAt(0).toLocaleUpperCase('ru') + cleaned.slice(1);
}

export function splitProductNameAndNote(value: string): { name: string; note?: string } {
  return { name: cleanProductName(value), note: extractProductNote(value) };
}

export function mergeNotes(...notes: Array<string | undefined>): string | undefined {
  const unique = [...new Set(notes.map((note) => note?.trim()).filter(Boolean))];
  return unique.length > 0 ? unique.join(', ') : undefined;
}

/** A single Unicode emoji; an image URL, a word or an empty string is not valid here. */
export function isValidEmoji(value: unknown): value is string {
  return typeof value === 'string' && EMOJI_PATTERN.test(value);
}

/**
 * Keep the prompt catalog under a bounded size: with more entries than the limit, only products
 * sharing a word with the pasted text are sent, best overlap first. Matching on the server still
 * uses the full visible catalog.
 */
export function selectCatalogForPrompt<T extends { name: string; nameEn: string }>(
  products: T[],
  text: string,
  limit = 400
): T[] {
  if (products.length <= limit) return products;

  const tokens = new Set(
    normalizeProductName(text)
      .split(' ')
      .filter((token) => token.length >= 2)
  );

  const scored = products.map((product, index) => {
    const words = normalizeProductName(`${product.name} ${product.nameEn}`).split(' ');
    const score = new Set(words.filter((word) => tokens.has(word))).size;
    return { product, index, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.product);
}
