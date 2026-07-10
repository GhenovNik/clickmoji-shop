/**
 * Shared prompt template for generating custom product emoji images
 *
 * This prompt is used across all AI image generation services (Imagen, DALL-E, etc.)
 * to ensure consistent emoji style and quality.
 *
 * @param productName - The name of the product to generate an emoji for
 * @param description - Optional extra context to improve generation quality
 * @returns The formatted prompt string for image generation
 */
export const EMOJI_GENERATION_PROMPT_VERSION = 'emoji-image-v1';

function normalizeCachePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getEmojiGenerationCacheKey(productName: string, description?: string): string {
  return [
    EMOJI_GENERATION_PROMPT_VERSION,
    normalizeCachePart(productName),
    normalizeCachePart(description || ''),
  ].join(':');
}

export function getEmojiGenerationPrompt(productName: string, description?: string): string {
  const normalizedDescription = description?.trim();
  const descriptionLine = normalizedDescription
    ? `Product description/context: ${normalizedDescription}.
Use this only as visual context for the icon shape/details.`
    : '';

  return `Vector illustration icon of ${productName}.
${descriptionLine}
Style: 3D emoji style, semi-flat look with soft volume.
MUST BE:
smooth rounded shapes,
soft plastic-like shading,
subtle gradients for depth and volume,
gentle specular highlights,
soft even lighting,
NO shadows or drop shadows,
NO black outlines (outline-free),
no text or symbols,
centered composition,
lots of white padding,
isolated on pure white background (#FFFFFF).
High quality emoji-style icon, consistent emoji pack look.
Minimalist but detailed enough to look appetizing.`;
}
