/** Public service failure: intentionally carries no provider message, prompt, key or cause. */
export class GoogleTextUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super('Google text generation is temporarily unavailable');
    this.name = 'GoogleTextUnavailableError';
  }
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ABORT_ERR',
]);

/** Read structured SDK errors, including Error.cause and Google's JSON-encoded message. */
function errorDetails(error: unknown): Record<string, unknown>[] {
  const details: Record<string, unknown>[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  // Bound traversal even for circular causes or recursively encoded provider messages.
  for (let index = 0; index < pending.length && index < 32; index += 1) {
    const value = pending[index];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const detail = value as Record<string, unknown>;
    details.push(detail);
    pending.push(detail.cause, detail.error);
    if (typeof detail.message === 'string' && detail.message.length <= 16_384) {
      try {
        pending.push(JSON.parse(detail.message));
      } catch {
        // Free-form messages are never classified or logged.
      }
    }
  }
  // If traversal was truncated, fail closed: an unseen nested 4xx must never be retried.
  return pending.length > 32 ? [] : details;
}

function httpStatus(value: unknown): number | undefined {
  const status =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[45]\d{2}$/.test(value)
        ? Number(value)
        : undefined;
  return status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

/** An allowlisted summary only; never returns arbitrary strings supplied by the provider. */
export function textAiErrorCode(error: unknown): string {
  const details = errorDetails(error);
  const statuses = details.flatMap((detail) =>
    [detail.status, detail.statusCode, detail.code]
      .map(httpStatus)
      .filter((status): status is number => status !== undefined)
  );
  // A real client rejection wins over every nested transient/timeout marker.
  const clientRejection = statuses.find((status) => status < 500 && status !== 429);
  if (clientRejection !== undefined) return String(clientRejection);
  if (statuses.includes(503)) return '503';
  if (statuses.includes(429)) return '429';
  for (const detail of details) {
    if (detail.status === 'UNAVAILABLE' || detail.code === 'UNAVAILABLE') return 'UNAVAILABLE';
    if (detail.status === 'RESOURCE_EXHAUSTED' || detail.code === 'RESOURCE_EXHAUSTED') {
      return 'RESOURCE_EXHAUSTED';
    }
  }
  if (
    details.some(
      (detail) =>
        detail.name === 'TimeoutError' ||
        detail.name === 'AbortError' ||
        (typeof detail.code === 'string' && TIMEOUT_CODES.has(detail.code))
    )
  ) {
    return 'TIMEOUT';
  }
  return 'UNKNOWN';
}

export function isTransientTextAiErrorCode(code: string): boolean {
  return ['503', '429', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'TIMEOUT'].includes(code);
}
