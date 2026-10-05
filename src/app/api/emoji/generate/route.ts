import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
import { generateEmojiImage } from '@/lib/services/emoji-assets';
import {
  EmojiProviderUnavailableError,
  IMAGE_PROVIDER_UNAVAILABLE_CODE,
  summarizeEmojiGenerationFailure,
} from '@/lib/services/emoji-errors';

const PROVIDER_UNAVAILABLE_MESSAGE =
  'AI image generation is unavailable right now (provider quota or API key). Pick a regular emoji instead.';

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

    // Image generation is the only provider call of this route, so it is the only place where a
    // provider error can appear: FR-10 logging is applied here, and the catch below therefore only
    // ever sees a failure of the request itself.
    let generated: Awaited<ReturnType<typeof generateEmojiImage>>;
    try {
      generated = await generateEmojiImage({ productName, description });
    } catch (error) {
      // FR-10: the log carries allowlisted fields only, never the SDK message, body or cause.
      console.error('Error generating AI emoji:', summarizeEmojiGenerationFailure(error));
      if (error instanceof EmojiProviderUnavailableError) {
        return NextResponse.json(
          { error: PROVIDER_UNAVAILABLE_MESSAGE, code: IMAGE_PROVIDER_UNAVAILABLE_CODE },
          { status: 503 }
        );
      }
      return NextResponse.json({ error: 'Failed to generate emoji' }, { status: 500 });
    }

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
    // No provider work happens outside the generation block, so this is a failure of the request
    // itself — a guard, a rate limit or an unparsable body — and it is logged with its class and
    // message: nothing of an image provider can reach this log.
    console.error('Error generating AI emoji:', error);
    return NextResponse.json({ error: 'Failed to generate emoji' }, { status: 500 });
  }
}
