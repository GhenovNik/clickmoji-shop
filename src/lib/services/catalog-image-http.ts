import { matchRemotePattern } from 'next/dist/shared/lib/match-remote-pattern';
import nextConfig from '../../../next.config';

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_HTTP_CONCURRENCY = 12;
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SupportedImageFormat = 'webp' | 'png' | 'jpeg' | 'gif' | 'avif' | 'bmp' | 'ico';

export type ImageProbeFailureKind =
  | 'INVALID_URL'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HEAD_GET_MISMATCH'
  | 'NOT_AN_IMAGE'
  | 'BODY_TOO_LARGE'
  | 'NON_200_HTTP';

export type ImageProbeResult =
  | {
      ok: true;
      status: 200;
      contentType: string;
      format: SupportedImageFormat;
      byteLength: number;
    }
  | {
      ok: false;
      kind: ImageProbeFailureKind;
      status?: number;
    };

export type OldImageProbeResult =
  | { kind: 'PROVEN_MISSING'; status: 404 | 410 }
  | { kind: 'STILL_PRESENT'; status: 200 }
  | { kind: 'UNKNOWN'; reason: string; status: number | string };

/**
 * Normalizes a catalogue entity name for matching (case-insensitive, Cyrillic yo-to-ye folding,
 * collapsed whitespace).
 */
export function normalizeCatalogName(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/**
 * Parses an HTTP(S) URL without whitespace or embedded credentials; returns null if malformed or
 * disallowed.
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
  if (parsed.username || parsed.password) return null;
  if (requireHttps) {
    if (parsed.protocol !== 'https:') return null;
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  return parsed;
}

/**
 * Validates an image URL against the exact Next.js `images.remotePatterns` contract used by the
 * storefront (`next.config.ts`). Fails closed if `remotePatterns` is missing or empty.
 */
export function isStorefrontImageUrl(rawUrl: string): boolean {
  const parsed = parseSafeHttpUrl(rawUrl, true);
  if (!parsed) return false;
  const remotePatterns = nextConfig.images?.remotePatterns;
  if (!remotePatterns || remotePatterns.length === 0) return false;
  return remotePatterns.some((pattern) => matchRemotePattern(pattern, parsed));
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

function asciiAt(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

/**
 * Detects a supported raster image format from its binary header bytes. Returns null for empty,
 * HTML, JSON, SVG, or unrecognized payloads.
 */
export function detectImageFormat(bytes: Uint8Array): SupportedImageFormat | null {
  if (bytes.byteLength === 0) return null;

  // WebP: "RIFF" + 4-byte size + "WEBP"
  if (
    bytes.byteLength >= 12 &&
    asciiAt(bytes, 0, 4) === 'RIFF' &&
    asciiAt(bytes, 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }

  // GIF: "GIF87a" or "GIF89a"
  if (bytes.byteLength >= 6) {
    const header = asciiAt(bytes, 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') {
      return 'gif';
    }
  }

  // AVIF: ISO BMFF "ftyp" box with avif/avis brand (major or compatible)
  if (bytes.byteLength >= 12 && asciiAt(bytes, 4, 8) === 'ftyp') {
    const majorBrand = asciiAt(bytes, 8, 12);
    if (majorBrand === 'avif' || majorBrand === 'avis') {
      return 'avif';
    }
    if (majorBrand === 'mif1' || majorBrand === 'msf1') {
      const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
      const limit = Math.min(bytes.byteLength, boxSize >= 16 ? boxSize : bytes.byteLength);
      for (let offset = 16; offset + 4 <= limit; offset += 4) {
        const compat = asciiAt(bytes, offset, offset + 4);
        if (compat === 'avif' || compat === 'avis') {
          return 'avif';
        }
      }
    }
  }

  // BMP: "BM"
  if (bytes.byteLength >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'bmp';
  }

  // ICO / CUR: 00 00 01 00 or 00 00 02 00
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    (bytes[2] === 0x01 || bytes[2] === 0x02) &&
    bytes[3] === 0x00
  ) {
    return 'ico';
  }

  return null;
}

/**
 * Checks whether an HTTP Content-Type header declares a non-SVG image MIME type.
 */
export function isAllowedImageMime(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mime.startsWith('image/')) return false;
  if (mime === 'image/svg+xml') return false;
  return true;
}

async function cancelBodySafely(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

type FetchStepResult =
  | { ok: true; response: Response; effectiveUrl: string; deadlineMs: number }
  | { ok: false; kind: 'INVALID_URL' | 'TIMEOUT' | 'NETWORK_ERROR' };

async function fetchWithSafeRedirects(
  initialUrl: string,
  method: 'HEAD' | 'GET',
  fetchImpl: typeof fetch,
  timeoutMs: number,
  requireHttps: boolean
): Promise<FetchStepResult> {
  const deadlineMs = Date.now() + timeoutMs;
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return { ok: false, kind: 'TIMEOUT' };
    }

    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch (error) {
      return { ok: false, kind: isTimeoutError(error) ? 'TIMEOUT' : 'NETWORK_ERROR' };
    }

    // Check effective URL if the transport (or a test double) already resolved redirects.
    if (response.url && !parseSafeHttpUrl(response.url, requireHttps)) {
      await cancelBodySafely(response);
      return { ok: false, kind: 'INVALID_URL' };
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await cancelBodySafely(response);
      if (hop === MAX_IMAGE_REDIRECTS || !location) {
        return { ok: false, kind: 'NETWORK_ERROR' };
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return { ok: false, kind: 'INVALID_URL' };
      }
      if (!parseSafeHttpUrl(nextUrl.toString(), requireHttps)) {
        return { ok: false, kind: 'INVALID_URL' };
      }
      currentUrl = nextUrl.toString();
      continue;
    }

    return {
      ok: true,
      response,
      effectiveUrl: response.url || currentUrl,
      deadlineMs,
    };
  }

  return { ok: false, kind: 'NETWORK_ERROR' };
}

type BoundedReadResult =
  | { ok: true; format: SupportedImageFormat; bytes: number }
  | { ok: false; kind: 'TIMEOUT' | 'NETWORK_ERROR' | 'NOT_AN_IMAGE' | 'BODY_TOO_LARGE' };

async function readChunkWithDeadline<T>(promise: Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) {
    const err = new Error('Body read timed out');
    err.name = 'TimeoutError';
    throw err;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Body read timed out');
          err.name = 'TimeoutError';
          reject(err);
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function readBoundedImageBody(
  response: Response,
  maxBytes: number,
  deadlineMs: number
): Promise<BoundedReadResult> {
  const rawContentLength = response.headers.get('content-length');
  if (rawContentLength !== null && /^\d+$/.test(rawContentLength.trim())) {
    const declaredLength = Number(rawContentLength.trim());
    if (declaredLength > maxBytes) {
      await cancelBodySafely(response);
      return { ok: false, kind: 'BODY_TOO_LARGE' };
    }
    if (declaredLength === 0) {
      await cancelBodySafely(response);
      return { ok: false, kind: 'NOT_AN_IMAGE' };
    }
  }

  if (!response.body) {
    return { ok: false, kind: 'NOT_AN_IMAGE' };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const remainingMs = deadlineMs - Date.now();
      const { done, value } = await readChunkWithDeadline(reader.read(), remainingMs);
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, kind: 'BODY_TOO_LARGE' };
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    return { ok: false, kind: isTimeoutError(error) ? 'TIMEOUT' : 'NETWORK_ERROR' };
  }

  if (totalBytes === 0) {
    return { ok: false, kind: 'NOT_AN_IMAGE' };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const format = detectImageFormat(combined);
  if (!format) {
    return { ok: false, kind: 'NOT_AN_IMAGE' };
  }

  return { ok: true, format, bytes: totalBytes };
}

/**
 * Verifies a live image URL with HEAD consistency check plus an authoritative bounded GET that
 * checks status 200, image/* Content-Type (no SVG/HTML), and actual raster image bytes within
 * `timeoutMs` and `maxBytes`. Never throws or echoes URLs or raw exceptions.
 */
export async function probeImageUrl(
  rawUrl: string,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
    requireHttps?: boolean;
  }
): Promise<ImageProbeResult> {
  const requireHttps = options?.requireHttps ?? false;
  const parsed = parseSafeHttpUrl(rawUrl, requireHttps);
  if (!parsed) {
    return { ok: false, kind: 'INVALID_URL' };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const urlString = parsed.toString();

  const headStep = await fetchWithSafeRedirects(
    urlString,
    'HEAD',
    fetchImpl,
    timeoutMs,
    requireHttps
  );
  if (!headStep.ok) {
    return { ok: false, kind: headStep.kind };
  }
  const headStatus = headStep.response.status;
  const headContentType = headStep.response.headers.get('content-type');
  await cancelBodySafely(headStep.response);

  const headUnsupported = headStatus === 405 || headStatus === 501;

  const getStep = await fetchWithSafeRedirects(
    urlString,
    'GET',
    fetchImpl,
    timeoutMs,
    requireHttps
  );
  if (!getStep.ok) {
    return { ok: false, kind: getStep.kind };
  }

  const getStatus = getStep.response.status;
  const getContentType = getStep.response.headers.get('content-type');

  if (!headUnsupported && headStatus !== getStatus) {
    await cancelBodySafely(getStep.response);
    return { ok: false, kind: 'HEAD_GET_MISMATCH', status: getStatus };
  }

  if (getStatus !== 200) {
    await cancelBodySafely(getStep.response);
    return { ok: false, kind: 'NON_200_HTTP', status: getStatus };
  }

  if (!isAllowedImageMime(getContentType)) {
    await cancelBodySafely(getStep.response);
    return { ok: false, kind: 'NOT_AN_IMAGE', status: 200 };
  }

  if (!headUnsupported && headContentType !== null && !isAllowedImageMime(headContentType)) {
    await cancelBodySafely(getStep.response);
    return { ok: false, kind: 'HEAD_GET_MISMATCH', status: 200 };
  }

  const bodyResult = await readBoundedImageBody(getStep.response, maxBytes, getStep.deadlineMs);
  if (!bodyResult.ok) {
    return { ok: false, kind: bodyResult.kind, status: 200 };
  }

  return {
    ok: true,
    status: 200,
    contentType: getContentType!,
    format: bodyResult.format,
    byteLength: bodyResult.bytes,
  };
}

/**
 * Probes an expected-broken old URL using both HEAD and GET. Only consistent permanent absence
 * (`404` or `410`, or `GET 404/410` when `HEAD` returns `405/501`) returns `PROVEN_MISSING`.
 * Any transient, rate-limited, ambiguous, or mismatched status (`429`, `503`, `TIMEOUT`,
 * `NETWORK_ERROR`, `HEAD 200 / GET 404`, etc.) is classified as `UNKNOWN` so callers refuse writes.
 */
export async function probeOldBrokenImage(
  rawUrl: string,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    requireHttps?: boolean;
  }
): Promise<OldImageProbeResult> {
  const requireHttps = options?.requireHttps ?? true;
  const parsed = parseSafeHttpUrl(rawUrl, requireHttps);
  if (!parsed) {
    return {
      kind: 'UNKNOWN',
      reason: 'Old URL is invalid or non-HTTPS; treating status as UNKNOWN',
      status: 'INVALID_URL',
    };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const urlString = parsed.toString();

  const headStep = await fetchWithSafeRedirects(
    urlString,
    'HEAD',
    fetchImpl,
    timeoutMs,
    requireHttps
  );
  if (!headStep.ok) {
    return {
      kind: 'UNKNOWN',
      reason: `Old URL HEAD check failed (${headStep.kind}); treating status as UNKNOWN`,
      status: headStep.kind,
    };
  }
  const headStatus = headStep.response.status;
  await cancelBodySafely(headStep.response);

  const getStep = await fetchWithSafeRedirects(
    urlString,
    'GET',
    fetchImpl,
    timeoutMs,
    requireHttps
  );
  if (!getStep.ok) {
    return {
      kind: 'UNKNOWN',
      reason: `Old URL GET check failed (${getStep.kind}); treating status as UNKNOWN`,
      status: getStep.kind,
    };
  }
  const getStatus = getStep.response.status;
  await cancelBodySafely(getStep.response);

  const headUnsupported = headStatus === 405 || headStatus === 501;

  if ((headStatus === 200 && getStatus === 200) || (headUnsupported && getStatus === 200)) {
    return { kind: 'STILL_PRESENT', status: 200 };
  }

  if (headStatus === 200 || getStatus === 200) {
    return {
      kind: 'UNKNOWN',
      reason: `Old URL returned inconsistent HEAD ${headStatus} / GET ${getStatus}; treating status as UNKNOWN`,
      status: 'HEAD_GET_MISMATCH',
    };
  }

  if ((headStatus === 404 || headStatus === 410) && getStatus === headStatus) {
    return { kind: 'PROVEN_MISSING', status: headStatus };
  }

  if (headUnsupported && (getStatus === 404 || getStatus === 410)) {
    return { kind: 'PROVEN_MISSING', status: getStatus };
  }

  return {
    kind: 'UNKNOWN',
    reason: `Old URL status is UNKNOWN (HEAD ${headStatus}, GET ${getStatus}); refusing overwrite`,
    status: headStatus === getStatus ? headStatus : `${headStatus}/${getStatus}`,
  };
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
