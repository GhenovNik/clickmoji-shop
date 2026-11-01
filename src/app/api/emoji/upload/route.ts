import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
import { uploadEmojiBase64Image } from '@/lib/services/emoji-assets';
import { EmptyEmojiImageError } from '@/lib/services/emoji-image-normalize';
import { recordEmojiLibraryItem, type EmojiLibrarySource } from '@/lib/services/emoji-library';

// Vercel caps a request body at 4.5 MB; a 3 MiB picture is about 4 MB as base64.
const MAX_BASE64_LENGTH = Math.ceil((3 * 1024 * 1024 * 4) / 3) + 64;

function librarySource(value: unknown): EmojiLibrarySource {
  return value === 'generated' ? 'generated' : 'upload';
}

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { base64, productName, name, nameEn, source } = await request.json();

    if (!base64 || typeof base64 !== 'string') {
      return NextResponse.json({ error: 'Base64 image is required' }, { status: 400 });
    }
    if (base64.length > MAX_BASE64_LENGTH) {
      return NextResponse.json({ error: 'Image is larger than 3 MB' }, { status: 413 });
    }

    const userLimit = await checkRateLimit({
      key: `ai:emoji-upload:${session.user.id}`,
      limit: 40,
      windowMs: 60 * 60 * 1000,
    });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.resetAt);
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
    if (error instanceof EmptyEmojiImageError) {
      return NextResponse.json(
        { error: 'На картинке не найден предмет: она пустая или целиком белая' },
        { status: 422 }
      );
    }
    console.error('Error uploading emoji:', error);
    return NextResponse.json({ error: 'Failed to upload emoji' }, { status: 500 });
  }
}
