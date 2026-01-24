/**
 * Shared prompt template for generating custom product emoji images
 *
 * This prompt is used across all AI image generation services (Imagen, DALL-E, etc.)
 * to ensure consistent emoji style and quality.
 *
 * @param productName - The name of the product to generate an emoji for
 * @returns The formatted prompt string for image generation
 */
export function getEmojiGenerationPrompt(productName: string): string {
  return `Vector illustration icon of ${productName}.
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
