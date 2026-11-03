export const GOOGLE_TEXT_MODEL_ENV = 'GOOGLE_TEXT_MODEL';
export const GOOGLE_TEXT_MODEL_FALLBACK_ENV = 'GOOGLE_TEXT_MODEL_FALLBACK';

export const DEFAULT_GOOGLE_TEXT_MODEL = 'gemini-3.8-flash';

// Reviewed text-output / structured-output models for this generateContent JSON path.
// Exact membership is intentional: Gemini naming grammar does not establish capability.
// Sources and the procedure for adding a model are in docs/ai.md#text-model-selection.
export const SUPPORTED_GOOGLE_TEXT_MODELS = Object.freeze([
  DEFAULT_GOOGLE_TEXT_MODEL,
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
] as const);
const supportedTextModels = new Set<string>(SUPPORTED_GOOGLE_TEXT_MODELS);

export class GoogleTextModelConfigurationError extends Error {
  readonly env: string;
  readonly code = 'UNSUPPORTED_TEXT_MODEL';

  constructor(model: string, env = GOOGLE_TEXT_MODEL_ENV) {
    super(
      `Invalid ${env} value "${model}": expected a supported generateContent text-generation model; allowed: ${SUPPORTED_GOOGLE_TEXT_MODELS.join(', ')}`
    );
    this.name = 'GoogleTextModelConfigurationError';
    this.env = env;
  }
}

function configuredModel(env: string): string | undefined {
  const model = process.env[env]?.trim();
  if (!model) return undefined;
  if (!supportedTextModels.has(model)) {
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
