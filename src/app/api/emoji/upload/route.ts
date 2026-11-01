import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { requireAdmin } from '@/lib/auth-guards';
import {
  checkRateLimit,
  getRequestLocale,
  getServerTranslator,
  rateLimitResponse,
} from '@/lib/auth-security';
import { uploadEmojiBase64Image } from '@/lib/services/emoji-assets';
import {
  EmojiImageTooLargeError,
  EmptyEmojiImageError,
} from '@/lib/services/emoji-image-normalize';
import { recordEmojiLibraryItem, type EmojiLibrarySource } from '@/lib/services/emoji-library';

// Vercel caps a request body at 4.5 MB; a 3 MiB picture is about 4 MB as base64.
const MAX_BASE64_LENGTH = Math.ceil((3 * 1024 * 1024 * 4) / 3) + 64;

function librarySource(value: unknown): EmojiLibrarySource {
  return value === 'generated' ? 'generated' : 'upload';
}

export async function POST(request: Request) {
  const locale = getRequestLocale(request);
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { base64, productName, name, nameEn, source } = await request.json();

    if (!base64 || typeof base64 !== 'string') {
      return NextResponse.json(
        { error: await apiText(request, 'base64Required') },
        { status: 400 }
      );
    }
    if (base64.length > MAX_BASE64_LENGTH) {
      return NextResponse.json(
        { error: await apiText(request, 'imageTooLarge3mb') },
        { status: 413 }
      );
    }

    const userLimit = await checkRateLimit({
      key: `ai:emoji-upload:${session.user.id}`,
      limit: 40,
      windowMs: 60 * 60 * 1000,
    });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.resetAt, locale);
    }

    const { imageUrl, fileName } = await uploadEmojiBase64Image({ base64, productName });

    await recordEmojiLibraryItem({
      imageUrl,
      name: String(name || productName || 'emoji'),
      nameEn: typeof nameEn === 'string' ? nameEn : null,
      source: librarySource(source),
    });

    return NextResponse.json({
      imageUrl,
      fileName,
    });
  } catch (error) {
    if (error instanceof EmojiImageTooLargeError) {
      return NextResponse.json(
        { error: getServerTranslator(locale)('api.emoji.tooLarge') },
        { status: 413 }
      );
    }
    if (error instanceof EmptyEmojiImageError) {
      return NextResponse.json(
        { error: getServerTranslator(locale)('api.emoji.emptyImage') },
        { status: 422 }
      );
    }
    console.error('Error uploading emoji:', error);
    return NextResponse.json(
      { error: await apiText(request, 'uploadEmojiFailed') },
      { status: 500 }
    );
  }
}
