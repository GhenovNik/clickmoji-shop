// @vitest-environment node
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError } from 'openai/core/error';
import type {
  EmojiImageClientFactory,
  GoogleImageClient,
  OpenAIImageClient,
} from '@/lib/services/emoji-image-adapters';
import {
  candidateWith,
  generateContentResponse,
  imagePart,
  restoreEnv,
  setEnv,
  snapshotEnv,
  SYNTHETIC_GOOGLE_KEY,
  SYNTHETIC_OPENAI_KEY,
  TINY_PNG_BASE64,
} from '@/test/emoji-image-fixtures';

const { ApiError } = await vi.importActual<typeof import('@google/genai')>('@google/genai');

const counters = vi.hoisted(() => ({
  constructedClients: [] as string[],
  sdkCalls: [] as string[],
  uploads: [] as File[],
}));

// The SDK constructors are mocked so that no test can reach the network: the injected client
// factory below is what the assertions count, and this module mock only keeps a base-branch call
// (a commit without the factory) offline and observable.
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor() {
      counters.constructedClients.push('google');
    }

    models = {
      generateImages: async () => {
        counters.sdkCalls.push('generateImages');
        throw new Error('synthetic: injected clients were not used');
      },
      generateContent: async () => {
        counters.sdkCalls.push('generateContent');
        throw new Error('synthetic: injected clients were not used');
      },
    };
  },
}));

vi.mock('openai', () => ({
  default: class {
    constructor() {
      counters.constructedClients.push('openai');
    }

    images = {
      generate: async () => {
        counters.sdkCalls.push('images.generate');
        throw new Error('synthetic: injected clients were not used');
      },
    };
  },
}));

vi.mock('uploadthing/server', () => ({
  UTApi: class {
    uploadFiles = async (file: File) => {
      counters.uploads.push(file);
      return { data: { url: 'https://utfs.io/f/synthetic-age-347.png' } };
    };
  },
}));

const { generateEmojiImage, generateAndUploadEmojiAsset } =
  await import('@/lib/services/emoji-assets');
const { EmojiProviderUnavailableError } = await import('@/lib/services/emoji-errors');

const envSnapshot = snapshotEnv();
const MARKER = 'synthetic-sdk-body-marker-347';

type ProviderCase = {
  label: string;
  provider: 'gemini' | 'gpt-image';
  apiKeyEnv: 'GOOGLE_GENAI_API_KEY' | 'OPENAI_API_KEY';
  modelEnv: 'GOOGLE_IMAGE_MODEL' | 'IMAGEN_MODEL' | 'OPENAI_IMAGE_MODEL';
  apiKey: string;
  model: string;
  sdkMethod: 'generateContent' | 'generateImages' | 'images.generate';
};

const PROVIDER_CASES: ProviderCase[] = [
  {
    label: 'Google generateContent',
    provider: 'gemini',
    apiKeyEnv: 'GOOGLE_GENAI_API_KEY',
    modelEnv: 'GOOGLE_IMAGE_MODEL',
    apiKey: SYNTHETIC_GOOGLE_KEY,
    model: 'gemini-3.1-flash-image',
    sdkMethod: 'generateContent',
  },
  {
    label: 'Google generateImages via the IMAGEN_MODEL synonym',
    provider: 'gemini',
    apiKeyEnv: 'GOOGLE_GENAI_API_KEY',
    modelEnv: 'IMAGEN_MODEL',
    apiKey: SYNTHETIC_GOOGLE_KEY,
    model: 'imagen-4.0-generate-001',
    sdkMethod: 'generateImages',
  },
  {
    label: 'OpenAI images.generate',
    provider: 'gpt-image',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_IMAGE_MODEL',
    apiKey: SYNTHETIC_OPENAI_KEY,
    model: 'gpt-image-2.5-flare',
    sdkMethod: 'images.generate',
  },
];

const MISSING_KEY_STATES = [
  { label: 'unset', value: undefined },
  { label: 'empty', value: '' },
  { label: 'whitespace only', value: '   \t ' },
];

/** The installed Google SDK puts the raw response body into the message (dist/node/index.mjs:13478-13483). */
function googleApiError(status: number, body: Record<string, unknown>) {
  return new ApiError({ status, message: JSON.stringify(body) });
}

function googleErrorBody(status: string, reason?: string) {
  return {
    error: {
      code: 400,
      message: `${MARKER} synthetic google body`,
      status,
      ...(reason
        ? {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason,
                domain: 'googleapis.com',
              },
            ],
          }
        : {}),
    },
  };
}

/** Google failures built by the SDK's own factory, so status and code come from the response body. */
function openaiApiError(status: number, code?: string) {
  return APIError.generate(
    status,
    { error: { message: `${MARKER} synthetic openai body`, code: code ?? null } },
    undefined,
    new Headers()
  );
}

type FailureCase = {
  label: string;
  appliesTo: 'gemini' | 'gpt-image';
  expectedReason?: 'quota' | 'auth';
  build: () => unknown;
};

const FAILURE_CASES: FailureCase[] = [
  {
    label: 'Google ApiError 429 RESOURCE_EXHAUSTED',
    appliesTo: 'gemini',
    expectedReason: 'quota',
    build: () => googleApiError(429, googleErrorBody('RESOURCE_EXHAUSTED')),
  },
  {
    label: 'Google ApiError 401 UNAUTHENTICATED',
    appliesTo: 'gemini',
    expectedReason: 'auth',
    build: () => googleApiError(401, googleErrorBody('UNAUTHENTICATED')),
  },
  {
    label: 'Google ApiError 403 PERMISSION_DENIED',
    appliesTo: 'gemini',
    expectedReason: 'auth',
    build: () => googleApiError(403, googleErrorBody('PERMISSION_DENIED')),
  },
  {
    label: 'Google ApiError 400 with the API_KEY_INVALID reason',
    appliesTo: 'gemini',
    expectedReason: 'auth',
    build: () => googleApiError(400, googleErrorBody('INVALID_ARGUMENT', 'API_KEY_INVALID')),
  },
  {
    label: 'Google ApiError 400 INVALID_ARGUMENT without an invalid key reason',
    appliesTo: 'gemini',
    build: () => googleApiError(400, googleErrorBody('INVALID_ARGUMENT')),
  },
  {
    label: 'Google ApiError 500',
    appliesTo: 'gemini',
    build: () => googleApiError(500, googleErrorBody('INTERNAL')),
  },
  {
    label: 'Google retry-layer text Retryable HTTP Error: Too Many Requests',
    appliesTo: 'gemini',
    expectedReason: 'quota',
    build: () => new Error('Retryable HTTP Error: Too Many Requests'),
  },
  {
    label: 'Google retry-layer text Non-retryable exception Unauthorized sending request',
    appliesTo: 'gemini',
    expectedReason: 'auth',
    build: () => new Error('Non-retryable exception Unauthorized sending request'),
  },
  {
    label: 'Google retry-layer text Non-retryable exception Forbidden sending request',
    appliesTo: 'gemini',
    expectedReason: 'auth',
    build: () => new Error('Non-retryable exception Forbidden sending request'),
  },
  {
    label: 'Google retry-layer text Retryable HTTP Error: Internal Server Error',
    appliesTo: 'gemini',
    build: () => new Error('Retryable HTTP Error: Internal Server Error'),
  },
  {
    label: 'Google network failure without a status',
    appliesTo: 'gemini',
    build: () => new TypeError('synthetic network failure'),
  },
  {
    label: 'OpenAI RateLimitError 429 insufficient_quota',
    appliesTo: 'gpt-image',
    expectedReason: 'quota',
    build: () => openaiApiError(429, 'insufficient_quota'),
  },
  {
    label: 'OpenAI 429 rate_limit_exceeded',
    appliesTo: 'gpt-image',
    expectedReason: 'quota',
    build: () => openaiApiError(429, 'rate_limit_exceeded'),
  },
  {
    label: 'OpenAI AuthenticationError 401 invalid_api_key',
    appliesTo: 'gpt-image',
    expectedReason: 'auth',
    build: () => openaiApiError(401, 'invalid_api_key'),
  },
  {
    label: 'OpenAI PermissionDeniedError 403',
    appliesTo: 'gpt-image',
    expectedReason: 'auth',
    build: () => openaiApiError(403),
  },
  {
    label: 'OpenAI BadRequestError 400',
    appliesTo: 'gpt-image',
    build: () => openaiApiError(400),
  },
  {
    label: 'OpenAI InternalServerError 500',
    appliesTo: 'gpt-image',
    build: () => openaiApiError(500),
  },
  {
    label: 'OpenAI APIConnectionError without a status',
    appliesTo: 'gpt-image',
    build: () => new APIConnectionError({ message: 'synthetic connection failure' }),
  },
];

/**
 * One test, one condition: the classifier reads the same fields the installed SDKs expose. The
 * doubles implement the single SDK method each adapter calls, so they are cast to the SDK client
 * type (`GoogleImageClient` / `OpenAIImageClient`) instead of reproducing the whole SDK surface.
 */
function failingClientFactory(
  providerCase: ProviderCase,
  failure: unknown
): EmojiImageClientFactory {
  const sdkCall = () => {
    counters.sdkCalls.push(providerCase.sdkMethod);
    throw failure;
  };

  if (providerCase.sdkMethod === 'images.generate') {
    return {
      createOpenAIClient: () => {
        counters.constructedClients.push('openai');
        return { images: { generate: sdkCall } } as unknown as OpenAIImageClient;
      },
    };
  }

  return {
    createGoogleClient: () => {
      counters.constructedClients.push('google');
      return {
        models: {
          generateImages: sdkCall,
          generateContent: sdkCall,
        },
      } as unknown as GoogleImageClient;
    },
  };
}

function workingClientFactory(providerCase: ProviderCase): EmojiImageClientFactory {
  if (providerCase.sdkMethod === 'images.generate') {
    return {
      createOpenAIClient: () => {
        counters.constructedClients.push('openai');
        return {
          images: {
            generate: async () => {
              counters.sdkCalls.push('images.generate');
              return { data: [{ b64_json: TINY_PNG_BASE64 }] };
            },
          },
        } as unknown as OpenAIImageClient;
      },
    };
  }

  return {
    createGoogleClient: () => {
      counters.constructedClients.push('google');
      return {
        models: {
          generateImages: async () => {
            counters.sdkCalls.push('generateImages');
            return { generatedImages: [{ image: { imageBytes: TINY_PNG_BASE64 } }] };
          },
          generateContent: async () => {
            counters.sdkCalls.push('generateContent');
            return generateContentResponse(candidateWith([imagePart()]));
          },
        },
      } as unknown as GoogleImageClient;
    },
  };
}

/** Only the active provider's model variable and key are set, as in production. */
function useProviderCase(providerCase: ProviderCase) {
  setEnv({
    AI_PROVIDER: providerCase.provider,
    GOOGLE_IMAGE_MODEL: undefined,
    IMAGEN_MODEL: undefined,
    OPENAI_IMAGE_MODEL: undefined,
    GOOGLE_GENAI_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    [providerCase.modelEnv]: providerCase.model,
    [providerCase.apiKeyEnv]: providerCase.apiKey,
  });
}

beforeEach(() => {
  counters.constructedClients.length = 0;
  counters.sdkCalls.length = 0;
  counters.uploads.length = 0;
  setEnv({
    AI_PROVIDER: undefined,
    GOOGLE_IMAGE_MODEL: undefined,
    IMAGEN_MODEL: undefined,
    OPENAI_IMAGE_MODEL: undefined,
    GOOGLE_GENAI_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(envSnapshot);
});

describe('AC-15 a missing provider key never reaches an SDK client', () => {
  for (const providerCase of PROVIDER_CASES) {
    for (const keyState of MISSING_KEY_STATES) {
      it(`reports missing-key without clients, calls or uploads on ${providerCase.label} with a ${keyState.label} key`, async () => {
        useProviderCase(providerCase);
        setEnv({ [providerCase.apiKeyEnv]: keyState.value });

        const generation = generateAndUploadEmojiAsset({
          productName: 'Milk',
          provider: providerCase.provider,
          clients: failingClientFactory(providerCase, new Error(`${MARKER} must not be reached`)),
        });

        await expect(generation).rejects.toMatchObject({
          name: 'EmojiProviderUnavailableError',
          code: 'image_provider_unavailable',
          reason: 'missing-key',
          provider: providerCase.provider,
          model: providerCase.model,
        });
        await expect(generation).rejects.toBeInstanceOf(EmojiProviderUnavailableError);
        expect(counters.constructedClients).toHaveLength(0);
        expect(counters.sdkCalls).toHaveLength(0);
        expect(counters.uploads).toHaveLength(0);
      });
    }
  }

  for (const providerCase of PROVIDER_CASES) {
    it(`counts one client, one SDK call and one upload on ${providerCase.label} with a valid synthetic key`, async () => {
      useProviderCase(providerCase);

      const asset = await generateAndUploadEmojiAsset({
        productName: 'Milk',
        provider: providerCase.provider,
        clients: workingClientFactory(providerCase),
      });

      expect(asset.model).toBe(providerCase.model);
      expect(counters.constructedClients).toHaveLength(1);
      expect(counters.sdkCalls).toEqual([providerCase.sdkMethod]);
      expect(counters.uploads).toHaveLength(1);
    });
  }
});

describe('AC-15 provider quota and auth failures are typed', () => {
  for (const providerCase of PROVIDER_CASES) {
    for (const failureCase of FAILURE_CASES.filter(
      (candidate) => candidate.appliesTo === providerCase.provider
    )) {
      if (failureCase.expectedReason === undefined) {
        it(`keeps the previous error for ${failureCase.label} on ${providerCase.label}`, async () => {
          useProviderCase(providerCase);
          const failure = failureCase.build();

          await expect(
            generateEmojiImage({
              productName: 'Milk',
              provider: providerCase.provider,
              clients: failingClientFactory(providerCase, failure),
            })
          ).rejects.toBe(failure);
          expect(counters.sdkCalls).toEqual([providerCase.sdkMethod]);
          expect(counters.uploads).toHaveLength(0);
        });
        continue;
      }

      it(`reports ${failureCase.expectedReason} after one SDK call for ${failureCase.label} on ${providerCase.label}`, async () => {
        useProviderCase(providerCase);

        await expect(
          generateEmojiImage({
            productName: 'Milk',
            provider: providerCase.provider,
            clients: failingClientFactory(providerCase, failureCase.build()),
          })
        ).rejects.toMatchObject({
          name: 'EmojiProviderUnavailableError',
          code: 'image_provider_unavailable',
          reason: failureCase.expectedReason,
          provider: providerCase.provider,
          model: providerCase.model,
        });
        expect(counters.constructedClients).toHaveLength(1);
        expect(counters.sdkCalls).toEqual([providerCase.sdkMethod]);
        expect(counters.uploads).toHaveLength(0);
      });
    }
  }
});

describe('AC-15 classification reads status strings and codes, not raw messages', () => {
  const gemini = PROVIDER_CASES[0];

  beforeEach(() => {
    useProviderCase(gemini);
  });

  it('reports quota for a RESOURCE_EXHAUSTED status string', async () => {
    const failure = Object.assign(new Error(`${MARKER} status string`), {
      status: 'RESOURCE_EXHAUSTED',
    });

    await expect(
      generateEmojiImage({
        productName: 'Milk',
        provider: gemini.provider,
        clients: failingClientFactory(gemini, failure),
      })
    ).rejects.toMatchObject({ reason: 'quota', provider: 'gemini', model: gemini.model });
  });

  it('reports auth for an UNAUTHENTICATED status string', async () => {
    const failure = Object.assign(new Error(`${MARKER} status string`), {
      status: 'UNAUTHENTICATED',
    });

    await expect(
      generateEmojiImage({
        productName: 'Milk',
        provider: gemini.provider,
        clients: failingClientFactory(gemini, failure),
      })
    ).rejects.toMatchObject({ reason: 'auth', provider: 'gemini', model: gemini.model });
  });

  it('reports quota for an insufficient_quota code without an HTTP status', async () => {
    const failure = Object.assign(new Error(`${MARKER} code only`), { code: 'insufficient_quota' });

    await expect(
      generateEmojiImage({
        productName: 'Milk',
        provider: gemini.provider,
        clients: failingClientFactory(gemini, failure),
      })
    ).rejects.toMatchObject({ reason: 'quota', provider: 'gemini', model: gemini.model });
  });

  it('does not leak the SDK body or the key into the typed error', async () => {
    const failure = googleApiError(429, googleErrorBody('RESOURCE_EXHAUSTED'));
    let caught: unknown;

    try {
      await generateEmojiImage({
        productName: 'Milk',
        provider: gemini.provider,
        clients: failingClientFactory(gemini, failure),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EmojiProviderUnavailableError);
    // A deep render, not JSON: an Error value hides its message from JSON.stringify, so an attached
    // raw SDK error would pass a JSON check unnoticed.
    const serialized = inspect(caught, { depth: 8 });
    expect(serialized).toContain('EmojiProviderUnavailableError');
    expect(Object.keys(caught as object).sort()).toEqual([
      'code',
      'model',
      'name',
      'provider',
      'reason',
    ]);
    expect(serialized).not.toContain(MARKER);
    expect(serialized).not.toContain(SYNTHETIC_GOOGLE_KEY);
  });
});
