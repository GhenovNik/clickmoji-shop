export const GOOGLE_TEXT_MODEL_ENV = 'GOOGLE_TEXT_MODEL';
export const GOOGLE_TEXT_MODEL_FALLBACK_ENV = 'GOOGLE_TEXT_MODEL_FALLBACK';

export const DEFAULT_GOOGLE_TEXT_MODEL = 'gemini-3.8-flash';

// Model id grammar, not a catalogue of models: an id that matches is routed, it is not guaranteed
// that the model itself accepts text input.
const GEMINI_TEXT_MODEL_ID_PATTERN = /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const GEMINI_IMAGE_MODEL_ID_PATTERN =
  /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*-image(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;

export class GoogleTextModelConfigurationError extends Error {
  readonly env: string;

  constructor(model: string, env = GOOGLE_TEXT_MODEL_ENV) {
    super(
      `Invalid ${env} value "${model}": expected a Gemini text model id (${GEMINI_TEXT_MODEL_ID_PATTERN.source}) that is not an image model`
    );
    this.name = 'GoogleTextModelConfigurationError';
    this.env = env;
  }
}

function configuredModel(env: string): string | undefined {
  const model = process.env[env]?.trim();
  if (!model) return undefined;
  if (!GEMINI_TEXT_MODEL_ID_PATTERN.test(model) || GEMINI_IMAGE_MODEL_ID_PATTERN.test(model)) {
    throw new GoogleTextModelConfigurationError(model, env);
  }
  return model;
}

/**
 * Unset, empty or whitespace-only falls back to the operator default; any other value is trimmed
 * and validated, so a configuration error is raised before an SDK client is created or a request is
 * sent.
 */
export function resolveGoogleTextModel(): string {
  return configuredModel(GOOGLE_TEXT_MODEL_ENV) ?? DEFAULT_GOOGLE_TEXT_MODEL;
}

/** No fallback is selected unless the operator explicitly supplies a valid text model id. */
export function resolveGoogleTextModelFallback(): string | undefined {
  return configuredModel(GOOGLE_TEXT_MODEL_FALLBACK_ENV);
}
