import { GoogleGenAI } from '@google/genai';
import {
  resolveGoogleTextModel,
  resolveGoogleTextModelFallback,
} from '@/lib/services/google-text-model';
import {
  GoogleTextUnavailableError,
  isTransientTextAiErrorCode,
  textAiErrorCode,
} from '@/lib/services/text-ai-errors';

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 8_000;
const TOTAL_BUDGET_MS = 30_000;

async function generateAttempt(
  client: GoogleGenAI,
  prompt: string,
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
          responseMimeType: 'application/json',
          abortSignal: controller.signal,
          httpOptions: { timeout: ATTEMPT_TIMEOUT_MS, retryOptions: { attempts: 1 } },
        },
      }),
      timeout,
    ]);
    if (!result.text) throw new Error('No response from AI');
    return result.text;
  } finally {
    clearTimeout(timer);
  }
}

/** Shared text-only policy; image generation deliberately does not use these retries. */
export async function generateGoogleText({ apiKey, prompt }: { apiKey: string; prompt: string }) {
  // Validate both settings before constructing the SDK, even when primary would succeed.
  const primary = resolveGoogleTextModel();
  const fallback = resolveGoogleTextModelFallback();
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
