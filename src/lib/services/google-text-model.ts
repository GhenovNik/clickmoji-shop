export const GOOGLE_TEXT_MODEL_ENV = 'GOOGLE_TEXT_MODEL';

export const DEFAULT_GOOGLE_TEXT_MODEL = 'gemini-3.8-flash';

// Model id grammar, not a catalogue of models: an id that matches is routed, it is not guaranteed
// that the model itself accepts text input.
const GEMINI_TEXT_MODEL_ID_PATTERN = /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const GEMINI_IMAGE_MODEL_ID_PATTERN =
  /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*-image(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;

export class GoogleTextModelConfigurationError extends Error {
  readonly env = GOOGLE_TEXT_MODEL_ENV;

  constructor(model: string) {
    super(
      `Invalid ${GOOGLE_TEXT_MODEL_ENV} value "${model}": expected a Gemini text model id (${GEMINI_TEXT_MODEL_ID_PATTERN.source}) that is not an image model`
    );
    this.name = 'GoogleTextModelConfigurationError';
  }
}

/**
 * Unset, empty or whitespace-only falls back to the operator default; any other value is trimmed
 * and validated, so a configuration error is raised before an SDK client is created or a request is
 * sent.
 */
export function resolveGoogleTextModel(): string {
  const raw = process.env[GOOGLE_TEXT_MODEL_ENV];
  const model = typeof raw === 'string' ? raw.trim() : '';

  if (model.length === 0) {
    return DEFAULT_GOOGLE_TEXT_MODEL;
  }
  if (!GEMINI_TEXT_MODEL_ID_PATTERN.test(model) || GEMINI_IMAGE_MODEL_ID_PATTERN.test(model)) {
    throw new GoogleTextModelConfigurationError(model);
  }
  return model;
}
