export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_HTTP_CONCURRENCY = 12;

export type ImageProbeResult =
  | { ok: true; status: number; contentType: string | null }
  | { ok: false; kind: 'INVALID_URL' | 'TIMEOUT' | 'NETWORK_ERROR' };

/**
 * Normalizes a catalogue entity name for matching (case-insensitive, ё→е, collapsed whitespace).
 */
export function normalizeCatalogName(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/**
 * Parses an HTTP(S) URL without whitespace; returns null if malformed or disallowed.
 */
export function parseSafeHttpUrl(raw: string, requireHttps = false): URL | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed !== raw || /\s/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (requireHttps) {
    if (parsed.protocol !== 'https:') return null;
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  return parsed;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (record.name === 'AbortError' || record.name === 'TimeoutError') return true;
  if (record.code === 'ETIMEDOUT' || record.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  if (record.cause && typeof record.cause === 'object') {
    const cause = record.cause as { name?: unknown; code?: unknown };
    if (
      cause.name === 'AbortError' ||
      cause.name === 'TimeoutError' ||
      cause.code === 'ETIMEDOUT' ||
      cause.code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return true;
    }
  }
  return false;
}

async function fetchStatusOnly(
  url: string,
  method: 'HEAD' | 'GET',
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<Response> {
  return fetchImpl(url, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Probes an image URL via HEAD (falling back to GET on 405/501) and drains the body safely.
 * Never throws or echoes the URL or raw network exception details.
 */
export async function probeImageUrl(
  rawUrl: string,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    requireHttps?: boolean;
  }
): Promise<ImageProbeResult> {
  const parsed = parseSafeHttpUrl(rawUrl, options?.requireHttps ?? false);
  if (!parsed) {
    return { ok: false, kind: 'INVALID_URL' };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  try {
    let response = await fetchStatusOnly(parsed.toString(), 'HEAD', fetchImpl, timeoutMs);
    await response.body?.cancel().catch(() => undefined);

    if (response.status === 405 || response.status === 501) {
      response = await fetchStatusOnly(parsed.toString(), 'GET', fetchImpl, timeoutMs);
      await response.body?.cancel().catch(() => undefined);
    }

    return {
      ok: true,
      status: response.status,
      contentType: response.headers.get('content-type'),
    };
  } catch (error) {
    return {
      ok: false,
      kind: isTimeoutError(error) ? 'TIMEOUT' : 'NETWORK_ERROR',
    };
  }
}

/**
 * Maps any unknown error to a safe diagnostic tag without exposing URLs, DB values, or secrets.
 */
export function safeErrorTag(error: unknown): string {
  if (error instanceof SafeOperationalError) {
    return error.code;
  }
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code)) {
      return `ERROR_${code}`;
    }
  }
  return 'INTERNAL_ERROR';
}

/**
 * Operational error whose code and safe summary never embed credentials, URLs, or row data.
 */
export class SafeOperationalError extends Error {
  readonly code: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.name = 'SafeOperationalError';
    this.code = code;
  }
}

/**
 * Runs async work over items with bounded concurrency, preserving input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex++;
      results[current] = await worker(items[current]!, current);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}
