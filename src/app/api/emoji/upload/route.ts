import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
import { uploadEmojiBase64Image } from '@/lib/services/emoji-assets';

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { base64, productName } = await request.json();

    if (!base64) {
      return NextResponse.json({ error: 'Base64 image is required' }, { status: 400 });
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

    return NextResponse.json({
      imageUrl,
      fileName,
    });
  } catch (error) {
    console.error('Error uploading emoji:', error);
    return NextResponse.json({ error: 'Failed to upload emoji' }, { status: 500 });
  }
}
