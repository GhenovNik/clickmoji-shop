import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { checkRateLimit, rateLimitResponse } from '@/lib/auth-security';
import { enforceAiQuota } from '@/lib/ai-quota';
import { generateEmojiImage, uploadEmojiImage } from '@/lib/services/emoji-assets';
import { recordEmojiLibraryItem } from '@/lib/services/emoji-library';
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

    const { productName, description, name, nameEn } = await request.json();

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

    // One unit of the administrator's daily AI budget for the image.
    const quotaResponse = await enforceAiQuota(session.user);
    if (quotaResponse) return quotaResponse;

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
    // A paid picture is kept at once: normalized, stored and recorded in the library, so closing
    // the form or generating again never loses it. The form only links the returned URL.
    const { imageUrl } = await uploadEmojiImage({
      imageBuffer: generated.imageBuffer,
      productName,
    });
    await recordEmojiLibraryItem({
      imageUrl,
      name: String(name || productName),
      nameEn: typeof nameEn === 'string' ? nameEn : null,
      source: 'generated',
    });

    return NextResponse.json({
      imageUrl,
      message: 'Image generated and saved to the emoji library.',
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
