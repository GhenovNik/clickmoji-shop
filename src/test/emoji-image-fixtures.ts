export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, 'base64');

export const SYNTHETIC_GOOGLE_KEY = 'synthetic-google-genai-key-for-tests';

export const SYNTHETIC_OPENAI_KEY = 'synthetic-openai-key-for-tests';

export type FakeInlineData = { mimeType?: string; data?: string };

export type FakePart = {
  inlineData?: FakeInlineData;
  thought?: boolean;
  text?: string;
};

export function imagePart(overrides: FakePart = {}): FakePart {
  return { inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 }, ...overrides };
}

export function textPart(text = 'thinking about milk'): FakePart {
  return { text };
}

export function candidateWith(parts: FakePart[], finishReason?: string) {
  return { content: { parts }, ...(finishReason === undefined ? {} : { finishReason }) };
}

export function generateContentResponse(candidate: unknown) {
  return { candidates: [candidate] };
}

export const LEGACY_ENV_KEYS = [
  'AI_PROVIDER',
  'IMAGEN_MODEL',
  'GOOGLE_IMAGE_MODEL',
  'OPENAI_IMAGE_MODEL',
  'GOOGLE_GENAI_API_KEY',
  'OPENAI_API_KEY',
];

export function snapshotEnv(keys: string[] = LEGACY_ENV_KEYS) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

export function restoreEnv(snapshot: Map<string, string | undefined>) {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
