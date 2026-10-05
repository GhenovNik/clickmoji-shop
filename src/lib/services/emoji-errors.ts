export type EmojiProvider = 'gemini' | 'gpt-image';

export type EmojiProviderUnavailableReason = 'missing-key' | 'quota' | 'auth';

export const IMAGE_PROVIDER_UNAVAILABLE_CODE = 'image_provider_unavailable';

/**
 * FR-9: the provider cannot serve an image generation right now. The error carries only the fields
 * the allowlist of FR-10 may log — never the SDK error, its message, body, headers or `cause` — so
 * the original failure cannot leak into a server log through this object.
 */
export class EmojiProviderUnavailableError extends Error {
  readonly code = IMAGE_PROVIDER_UNAVAILABLE_CODE;
  readonly reason: EmojiProviderUnavailableReason;
  readonly provider: EmojiProvider;
  readonly model: string;

  constructor({
    reason,
    provider,
    model,
  }: {
    reason: EmojiProviderUnavailableReason;
    provider: EmojiProvider;
    model: string;
  }) {
    super(`Emoji image provider ${provider} is unavailable (${reason}) for model ${model}`);
    this.name = 'EmojiProviderUnavailableError';
    this.reason = reason;
    this.provider = provider;
    this.model = model;
  }
}

const QUOTA_CODES = new Set(['insufficient_quota', 'rate_limit_exceeded', 'RESOURCE_EXHAUSTED']);
const AUTH_CODES = new Set(['UNAUTHENTICATED', 'PERMISSION_DENIED']);

/**
 * The Google SDK reports a status in the message text when its retry layer is active
 * (`@google/genai/dist/node/index.mjs:13318,13320`). The fragments are whole phrases, so only the
 * statuses FR-9 names are recognized and a 500 (`Internal Server Error`) stays a plain failure.
 */
const GOOGLE_QUOTA_MESSAGE_FRAGMENTS = ['Retryable HTTP Error: Too Many Requests'];
const GOOGLE_AUTH_MESSAGE_FRAGMENTS = [
  'Non-retryable exception Unauthorized sending request',
  'Non-retryable exception Forbidden sending request',
];
const GOOGLE_INVALID_KEY_FRAGMENT = 'API_KEY_INVALID';

type ProviderFailureReason = 'quota' | 'auth';

function readNumberField(target: unknown, field: string): number | undefined {
  if (typeof target !== 'object' || target === null) {
    return undefined;
  }
  const value = (target as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringField(target: unknown, field: string): string | undefined {
  if (typeof target !== 'object' || target === null) {
    return undefined;
  }
  const value = (target as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  return readStringField(value, 'message') ?? '';
}

/**
 * FR-9 classification, by the fields the installed SDKs expose: `status` (`openai` core/error.d.ts:6,
 * `@google/genai` genai.d.ts:337) and `code` (openai core/error.d.ts:11). The message text is only a
 * fallback for the Google SDK statuses it reports in text. Everything else — a plain 400, a 500, a
 * network failure, a configuration error, any FR-3 class — stays the previous error.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureReason | undefined {
  const status = readNumberField(error, 'status');
  const statusText = readStringField(error, 'status');
  const code = readStringField(error, 'code');

  if (status === 429 || (statusText !== undefined && QUOTA_CODES.has(statusText))) {
    return 'quota';
  }
  if (code !== undefined && QUOTA_CODES.has(code)) {
    return 'quota';
  }
  if (
    status === 401 ||
    status === 403 ||
    (statusText !== undefined && AUTH_CODES.has(statusText))
  ) {
    return 'auth';
  }
  if (code !== undefined && AUTH_CODES.has(code)) {
    return 'auth';
  }

  const message = readMessage(error);
  if (message.includes(GOOGLE_INVALID_KEY_FRAGMENT) && (status === 400 || status === undefined)) {
    return 'auth';
  }
  if (status === undefined) {
    if (GOOGLE_QUOTA_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))) {
      return 'quota';
    }
    if (GOOGLE_AUTH_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))) {
      return 'auth';
    }
  }

  return undefined;
}

/**
 * The FR-3 classes of the spec plus the FR-2 configuration class. The class travels on the error
 * object, so the log record never has to be derived from a message text: a `blocked-prompt` failure
 * and a `blocked` one are told apart by the field, not by the order of a substring search.
 */
const EMOJI_IMAGE_ERROR_CLASSES = [
  'blocked-prompt',
  'blocked',
  'incomplete',
  'no-image',
  'unsupported-format',
  'empty-image',
  'invalid-png',
  'too-large',
] as const;

export type EmojiImageErrorClass = (typeof EMOJI_IMAGE_ERROR_CLASSES)[number];

export type EmojiImageErrorKind = EmojiImageErrorClass | 'configuration';

/**
 * An image failure the service itself classified: an FR-3 class of the Gemini `generateContent`
 * response, or an FR-2 configuration error for a model id outside the grammar. The class name is a
 * field of this error, never a substring matched against the message of an arbitrary SDK error,
 * whose text may use the same words for an unrelated reason.
 */
export class EmojiImageGenerationError extends Error {
  readonly kind: EmojiImageErrorKind;

  constructor(kind: EmojiImageErrorKind, message: string) {
    super(message);
    this.name = 'EmojiImageGenerationError';
    this.kind = kind;
  }
}

export type EmojiGenerationLogRecord = {
  errorClass: string;
  reason?: EmojiProviderUnavailableReason;
  status?: number;
  provider?: EmojiProvider;
  model?: string;
};

/**
 * FR-10: the only record a route may log for a generation failure. Fields come from the typed error
 * or from fixed class names; no raw message, body, header or `cause` is ever copied into it. An error
 * this service did not create has no class of ours, so it is reported as `Error` with its HTTP
 * status, if the SDK exposes one.
 */
export function summarizeEmojiGenerationFailure(error: unknown): EmojiGenerationLogRecord {
  if (error instanceof EmojiProviderUnavailableError) {
    return {
      errorClass: error.name,
      reason: error.reason,
      provider: error.provider,
      model: error.model,
    };
  }

  if (error instanceof EmojiImageGenerationError) {
    return { errorClass: error.kind };
  }

  const status = readNumberField(error, 'status');

  return status === undefined ? { errorClass: 'Error' } : { errorClass: 'Error', status };
}
