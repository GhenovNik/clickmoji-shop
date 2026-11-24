import { GoogleGenAI } from '@google/genai';
import { AI_INPUT_LIMITS, AiInputTooLargeError } from '@/lib/ai-input-validation';
import {
  MAX_TEXT_OUTPUT_TOKENS,
  promptTokenUpperBound,
  recordTextProviderAttempt,
  TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD,
} from '@/lib/ai-pricing';
import { getActiveAiQuotaContext } from '@/lib/ai-quota-context';
import {
  GOOGLE_TEXT_MODEL_ENV,
  GOOGLE_TEXT_MODEL_FALLBACK_ENV,
  GoogleTextModelConfigurationError,
  resolveGoogleTextModel,
  resolveGoogleTextModelFallback,
  SUPPORTED_GOOGLE_TEXT_MODELS,
} from '@/lib/services/google-text-model';
import {
  GoogleTextUnavailableError,
  isTransientTextAiErrorCode,
  textAiErrorCode,
} from '@/lib/services/text-ai-errors';

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 8_000;
const TOTAL_BUDGET_MS = 30_000;

// Only explicit client/validation/auth/rate-limit rejections are guaranteed non-billed.
// Ambiguous upstream failures (408, 500, 502, 503, 504, UNAVAILABLE, TIMEOUT, network resets)
// are recorded as potentially billed ('timeout' / 'error').
const NON_BILLABLE_ERROR_CODES = new Set([
  '400',
  '401',
  '403',
  '404',
  '422',
  '429',
  'RESOURCE_EXHAUSTED',
]);

async function generateAttempt(
  client: GoogleGenAI,
  prompt: string,
  promptBytes: number,
  model: string,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DOMException('Google text attempt timed out', 'TimeoutError'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Race as well as abort: an SDK/transport that ignores cancellation must still settle.
    const result = await Promise.race([
      client.models.generateContent({
        model,
        contents: prompt,
        config: {
          candidateCount: 1,
          responseMimeType: 'application/json',
          maxOutputTokens: MAX_TEXT_OUTPUT_TOKENS,
          abortSignal: controller.signal,
          httpOptions: { timeout: ATTEMPT_TIMEOUT_MS, retryOptions: { attempts: 1 } },
        },
      }),
      timeout,
    ]);
    recordTextProviderAttempt({
      model,
      promptChars: prompt.length,
      promptBytes,
      outcome: 'ok',
      usageMetadata: result.usageMetadata,
    });
    if (!result.text) throw new Error('No response from AI');
    return result.text;
  } catch (error) {
    if (!(error instanceof Error && error.message === 'No response from AI')) {
      const code = textAiErrorCode(error);
      const outcome =
        code === 'TIMEOUT' || code === '408'
          ? 'timeout'
          : NON_BILLABLE_ERROR_CODES.has(code)
            ? 'rejected'
            : 'error';
      recordTextProviderAttempt({
        model,
        promptChars: prompt.length,
        promptBytes,
        outcome,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Shared text-only policy; image generation deliberately does not use these retries. */
export async function generateGoogleText({ apiKey, prompt }: { apiKey: string; prompt: string }) {
  // Validate both settings before constructing the SDK, even when primary would succeed.
  let primary: string;
  let fallback: string | undefined;
  try {
    primary = resolveGoogleTextModel();
    fallback = resolveGoogleTextModelFallback();
  } catch (error) {
    if (error instanceof GoogleTextModelConfigurationError) {
      // Never log the raw configured value or Error.message: either could contain a pasted key.
      console.error('Google text model configuration rejected:', {
        code: error.code,
        env: error.env,
        expected: 'An explicitly supported generateContent text-generation model',
        supportedModels: SUPPORTED_GOOGLE_TEXT_MODELS,
      });
    }
    throw error;
  }

  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (
    prompt.length > AI_INPUT_LIMITS.MAX_TEXT_PROMPT_CHARS ||
    promptBytes > AI_INPUT_LIMITS.MAX_TEXT_PROMPT_BYTES
  ) {
    throw new AiInputTooLargeError('Text AI prompt exceeds maximum length');
  }

  const quotaCtx = getActiveAiQuotaContext();
  if (quotaCtx?.kind === 'text' && quotaCtx.textBounds) {
    const promptTokens = promptTokenUpperBound(prompt, TEXT_PROMPT_FRAMING_TOKEN_OVERHEAD);
    if (promptTokens > quotaCtx.textBounds.maxPromptTokens) {
      throw new AiInputTooLargeError('Text AI prompt exceeds reserved monthly budget bound');
    }
    if (primary !== quotaCtx.textBounds.primaryModel) {
      throw new GoogleTextModelConfigurationError(primary, GOOGLE_TEXT_MODEL_ENV);
    }
    if (fallback !== quotaCtx.textBounds.fallbackModel) {
      throw new GoogleTextModelConfigurationError(
        fallback ?? primary,
        GOOGLE_TEXT_MODEL_FALLBACK_ENV
      );
    }
  }

  // In SDK 1.52 the no-client-retryOptions path performs exactly one fetch and preserves ApiError.
  // Enabling client-level retryOptions (even attempts: 1) instead erases HTTP status on failures.
  // Keep it unset; the real-SDK transport regression tests guard this as well as the request hint.
  const client = new GoogleGenAI({ apiKey });
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GoogleTextUnavailableError();
    const model = attempt === MAX_ATTEMPTS ? (fallback ?? primary) : primary;
    try {
      const text = await generateAttempt(
        client,
        prompt,
        promptBytes,
        model,
        Math.min(ATTEMPT_TIMEOUT_MS, remaining)
      );
      console.info({ code: 'OK', attempt });
      return { text, model };
    } catch (error) {
      const code = textAiErrorCode(error);
      console.info({ code, attempt });
      if (!isTransientTextAiErrorCode(code)) throw error;
      if (attempt === MAX_ATTEMPTS) throw new GoogleTextUnavailableError();
    }
    // Equal jitter: [500, 1000) ms then [1000, 2000) ms, never a post-exhaustion sleep.
    const baseDelay = 500 * 2 ** (attempt - 1);
    const delay = Math.floor(baseDelay * (1 + Math.random()));
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now())))
    );
  }
  throw new GoogleTextUnavailableError();
}
