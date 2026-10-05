/**
 * Shared prompt template for generating custom product emoji images
 *
 * This prompt is used across all AI image generation services (Imagen, DALL-E, etc.)
 * to ensure consistent emoji style and quality.
 *
 * The Google path renders the white-field variant; the OpenAI path renders the transparent
 * variant, which is the same template with both white-field lines replaced.
 *
 * @param productName - The name of the product to generate an emoji for
 * @param description - Optional extra context to improve generation quality
 * @param variant - Prompt variant to render; defaults to the white-field variant
 * @returns The formatted prompt string for image generation
 */
export const EMOJI_GENERATION_PROMPT_VERSION = 'emoji-image-v1';

export const EMOJI_GENERATION_TRANSPARENT_PROMPT_VERSION = 'emoji-image-v1-transparent';

export type EmojiGenerationPromptVersion =
  typeof EMOJI_GENERATION_PROMPT_VERSION | typeof EMOJI_GENERATION_TRANSPARENT_PROMPT_VERSION;

const PADDING_AND_BACKGROUND_LINES: Record<EmojiGenerationPromptVersion, [string, string]> = {
  [EMOJI_GENERATION_PROMPT_VERSION]: [
    'lots of white padding,',
    'isolated on pure white background (#FFFFFF).',
  ],
  [EMOJI_GENERATION_TRANSPARENT_PROMPT_VERSION]: [
    'generous transparent padding, no background colour or fill,',
    'isolated on a fully transparent background.',
  ],
};

function normalizeCachePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getEmojiGenerationCacheKey(
  productName: string,
  description?: string,
  version: EmojiGenerationPromptVersion = EMOJI_GENERATION_PROMPT_VERSION
): string {
  return [version, normalizeCachePart(productName), normalizeCachePart(description || '')].join(
    ':'
  );
}

export function getEmojiGenerationPrompt(
  productName: string,
  description?: string,
  version: EmojiGenerationPromptVersion = EMOJI_GENERATION_PROMPT_VERSION
): string {
  const normalizedDescription = description?.trim();
  const descriptionLine = normalizedDescription
    ? `Product description/context: ${normalizedDescription}.
Use this only as visual context for the icon shape/details.`
    : '';
  const [paddingLine, backgroundLine] = PADDING_AND_BACKGROUND_LINES[version];

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
${paddingLine}
${backgroundLine}
High quality emoji-style icon, consistent emoji pack look.
Minimalist but detailed enough to look appetizing.`;
}
