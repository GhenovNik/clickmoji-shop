import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
import { generateEmojiImage } from '@/lib/services/emoji-assets';

export async function POST(request: Request) {
  try {
    // Authorization is enforced before any provider work starts.
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    const { productName, description } = await request.json();

    if (!productName) {
      return NextResponse.json({ error: 'Product name is required' }, { status: 400 });
    }

    const userLimit = await checkRateLimit({
      key: `ai:emoji-generate:${session.user.id}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!userLimit.allowed) {
      return rateLimitResponse(userLimit.resetAt);
    }

    const generated = await generateEmojiImage({ productName, description });

    // Return a preview without persisting it to UploadThing.
    const base64Image = `data:image/png;base64,${generated.imageBuffer.toString('base64')}`;

    return NextResponse.json({
      base64: base64Image,
      message: 'Image generated successfully. Will be uploaded when product is saved.',
      provider: generated.provider,
      model: generated.model,
      promptVersion: generated.promptVersion,
      cacheKey: generated.cacheKey,
    });
  } catch (error) {
    console.error('Error generating AI emoji:', error);
    return NextResponse.json({ error: 'Failed to generate emoji' }, { status: 500 });
  }
}
