import { UTApi } from 'uploadthing/server';
import {
  generateWithGoogleImage,
  generateWithOpenAI,
  type EmojiImageClientFactory,
} from '@/lib/services/emoji-image-adapters';
import { getEmojiGenerationCacheKey } from '@/lib/prompts/emoji-generation';

export type EmojiProvider = 'gemini' | 'gpt-image';

type GenerateEmojiImageOptions = {
  productName: string;
  description?: string;
  provider?: string;
  clients?: EmojiImageClientFactory;
};

type UploadEmojiImageOptions = {
  imageBuffer: Buffer;
  productName?: string;
  utapi?: UTApi;
};

function getProvider(value?: string): EmojiProvider {
  return value === 'gpt-image' ? 'gpt-image' : 'gemini';
}

function emojiFileName(productName?: string) {
  const slug = productName?.toLowerCase().trim().replace(/\s+/g, '-') || 'product';
  return `ai-emoji-${slug}-${Date.now()}.png`;
}

export async function generateEmojiImage({
  productName,
  description,
  provider: providerInput = process.env.AI_PROVIDER,
  clients,
}: GenerateEmojiImageOptions) {
  const provider = getProvider(providerInput);

  if (provider === 'gpt-image') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
    }
    const generated = await generateWithOpenAI({ productName, description, apiKey }, clients);
    return {
      ...generated,
      provider,
      cacheKey: getEmojiGenerationCacheKey(productName, description, generated.promptVersion),
    };
  }

  const apiKey = process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Google Generative AI API key not configured');
  }
  const generated = await generateWithGoogleImage({ productName, description, apiKey }, clients);
  return {
    ...generated,
    provider,
    cacheKey: getEmojiGenerationCacheKey(productName, description, generated.promptVersion),
  };
}

export async function uploadEmojiImage({
  imageBuffer,
  productName,
  utapi = new UTApi(),
}: UploadEmojiImageOptions) {
  const fileName = emojiFileName(productName);
  const file = new File([new Uint8Array(imageBuffer)], fileName, { type: 'image/png' });
  const uploadResult = await utapi.uploadFiles(file);

  if (!uploadResult || uploadResult.error) {
    throw new Error('Failed to upload image to storage');
  }

  const imageUrl = uploadResult.data?.url;
  if (!imageUrl) {
    throw new Error('Upload succeeded but no URL returned');
  }

  return {
    imageUrl,
    fileName,
  };
}

export function base64ToImageBuffer(base64: string) {
  const base64Data = base64.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

export async function uploadEmojiBase64Image({
  base64,
  productName,
}: {
  base64: string;
  productName?: string;
}) {
  return uploadEmojiImage({
    imageBuffer: base64ToImageBuffer(base64),
    productName,
  });
}

export async function generateAndUploadEmojiAsset({
  productName,
  description,
  provider,
}: GenerateEmojiImageOptions) {
  const generated = await generateEmojiImage({ productName, description, provider });
  const uploaded = await uploadEmojiImage({
    imageBuffer: generated.imageBuffer,
    productName,
  });

  return {
    ...uploaded,
    provider: generated.provider,
    model: generated.model,
    promptVersion: generated.promptVersion,
    cacheKey: generated.cacheKey,
  };
}
