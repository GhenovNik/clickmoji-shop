import { NextResponse } from 'next/server';
import type { Locale } from '@/i18n/config';
import { getServerTranslator } from '@/lib/auth-security';

export const AI_INPUT_LIMITS = {
  SMART_CREATE_BODY_MAX_BYTES: 8_192,
  EMOJI_GENERATE_BODY_MAX_BYTES: 16_384,
  IMPORT_TEXT_BODY_MAX_BYTES: 16_384,
  BULK_IMPORT_BODY_MAX_BYTES: 32_768,
  MAX_PRODUCT_NAME_LENGTH: 120,
  MAX_CATEGORY_ID_LENGTH: 64,
  MAX_EMOJI_DESCRIPTION_LENGTH: 500,
  MAX_BULK_IMPORT_ITEMS: 50,
  MAX_BULK_IMPORT_TOTAL_CHARS: 2_000,
  MAX_IMPORT_TEXT_CHARS: 2_000,
  MAX_TEXT_PROMPT_CHARS: 120_000,
  MAX_TEXT_PROMPT_BYTES: 120_000,
  MAX_IMAGE_PROMPT_CHARS: 2_000,
  MAX_IMAGE_PROMPT_BYTES: 4_000,
} as const;

export const CATEGORY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class AiInputTooLargeError extends Error {
  readonly status = 413;

  constructor(message = 'AI input exceeds maximum allowed size') {
    super(message);
    this.name = 'AiInputTooLargeError';
  }
}

type BoundedBodyNamespace = 'products' | 'errors' | 'import';

async function readUtf8BodyWithinLimit(request: Request, maxBytes: number): Promise<string | null> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader.trim());
    if (Number.isFinite(declared) && declared > maxBytes) {
      return null;
    }
  }

  if (!request.body) {
    const text = await request.text();
    return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * Reads and parses a JSON object request body with a strict UTF-8 byte ceiling before
 * any downstream validation or AI provider work runs. Returns 413 on oversized bodies and 400
 * on malformed or non-object JSON.
 */
export async function readBoundedJsonBody({
  request,
  maxBytes,
  locale,
  namespace,
}: {
  request: Request;
  maxBytes: number;
  locale: Locale;
  namespace: BoundedBodyNamespace;
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const t = getServerTranslator(locale);
  const rawText = await readUtf8BodyWithinLimit(request, maxBytes);
  if (rawText === null) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: t(`api.${namespace}.payloadTooLarge`) },
        { status: 413 }
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: t(`api.${namespace}.invalidRequest`) }, { status: 400 }),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      response: NextResponse.json({ error: t(`api.${namespace}.invalidRequest`) }, { status: 400 }),
    };
  }

  return { ok: true, body: parsed as Record<string, unknown> };
}
