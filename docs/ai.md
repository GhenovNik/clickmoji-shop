# AI Features

AI is used for emoji generation and product automation. Providers can be switched by `AI_PROVIDER`.

## Providers

- Google GenAI SDK: Gemini (text), Imagen (image)
- OpenAI SDK: GPT Image (optional)

## Image model selection

The image model is configuration, not code: two optional variables switch it without a release.

| Variable             | Unset / empty / whitespace                                                          | Non-empty value (trimmed)    |
| -------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| `GOOGLE_IMAGE_MODEL` | legacy: `IMAGEN_MODEL` or `imagen-4.0-generate-001`, always `models.generateImages` | routed by id grammar (below) |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1.5` via `images.generate({ model, prompt })`                            | that model via the same call |

Only the variable of the active provider (`AI_PROVIDER`) is read. The model family never changes
by itself: an invalid value fails at generation time with a configuration error that names the
variable and its value, before any SDK call.

Google adapter grammar (full match, no flags):

- `^imagen-[a-z0-9]+(?:[.-][a-z0-9]+)*$` → `models.generateImages` (same request and parsing as the
  legacy path)
- `^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*-image(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$` →
  `models.generateContent({ model, contents: prompt, config: { responseModalities: ['IMAGE'],
imageConfig: { aspectRatio: '1:1' } } })`
- anything else (`gemini-image`, `gemini-2.5-flash`, `dall-e-3`, `foo`, uppercase, spaces, newlines,
  `models/...`) → configuration error

The grammar is a shape check, not a model catalogue: a matching id is routed, it does not guarantee
that the model can generate images. For OpenAI the chosen model must support
`images.generate({ model, prompt })` and return base64 PNG (`data[0].b64_json`).

## Adapter error classes

The Gemini adapter classifies a `generateContent` response in this fixed order, first match wins:

| Class                | Cause                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blocked-prompt`     | no candidates or an empty array; `promptFeedback.blockReason` (or `none`) is in the message                                                                                     |
| `blocked`            | `finishReason` in `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION`, even when a PNG is present |
| `incomplete`         | any other `finishReason` (including unknown values)                                                                                                                             |
| `no-image`           | no final `content.parts` image part (no content, text only, thought images only)                                                                                                |
| `unsupported-format` | the first final image part is not `image/png`                                                                                                                                   |
| `empty-image`        | missing or empty `data`, or data decoding to zero bytes                                                                                                                         |
| `invalid-png`        | bytes without the PNG signature                                                                                                                                                 |
| `too-large`          | more than 10 MiB                                                                                                                                                                |

Each class is an `Error` whose text contains the class name and never contains keys or response
content. Classes are visible in the server log (through the existing `console.error` of the callers)
and are not exposed in HTTP responses. Exactly one adapter call is made per generation: there is no
fallback to another provider or model.

## Switching and rolling back

1. Pick the model and check it against the grammar (or, for OpenAI, against the `images.generate`
   contract above).
2. Set `GOOGLE_IMAGE_MODEL` or `OPENAI_IMAGE_MODEL` in the Vercel environment (see `docs/ops.md`) and
   redeploy. No code release is needed.
3. Generate one emoji manually and read the server log: success, or an adapter error class.
4. Roll back by removing the variable and redeploying — that returns the service to the legacy path
   (it does not restore a retired legacy model). Rolling back code is one revert of the squash commit.

Model EOL: the `imagen-4.0-*` family was retired on 2026-08-17, `gpt-image-1.5` is retired on
2026-12-01.

## Implemented flows

- Emoji generation: `POST /api/emoji/generate`
- Bulk import: `POST /api/products/bulk-import`
- Smart create: `POST /api/products/smart-create`
- Import list from free text: `POST /api/lists/import-text`

## Service boundaries

- Text/product automation lives in `src/lib/services/ai-products.ts`.
- Emoji image generation and UploadThing upload orchestration live in
  `src/lib/services/emoji-assets.ts`.
- Image provider adapters (legacy Imagen, Gemini `generateContent`, OpenAI, response classification)
  live in `src/lib/services/emoji-image-adapters.ts`.
- Route handlers are responsible for auth, request validation, rate-limit checks, service calls,
  and HTTP responses.
- Internal self-HTTP between route handlers is avoided. `smart-create` calls the emoji asset
  service directly when custom image generation is needed.

## Prompt style (current)

Emoji icons are generated in a flat, clean, vector-like style. The emoji prompt is centralized in
`src/lib/prompts/emoji-generation.ts` and versioned with
`EMOJI_GENERATION_PROMPT_VERSION`.

Text automation prompts use `AI_PRODUCTS_PROMPT_VERSION` from
`src/lib/services/ai-products.ts`. AI responses include prompt metadata where it is useful for
debugging or cache strategy.

## Rate limits

AI endpoints use `checkRateLimit` with the in-memory fallback or Upstash Redis when configured:

- `POST /api/emoji/generate`: `ai:emoji-generate:<userId>`, 20 requests/hour
- `POST /api/emoji/upload`: `ai:emoji-upload:<userId>`, 40 requests/hour
- `POST /api/products/bulk-import`: `ai:bulk-import:<userId>`, 10 requests/hour
- `POST /api/products/smart-create`: `ai:smart-create:<userId>`, 20 requests/hour
- `POST /api/lists/import-text`: `ai:import:<userId>`, 10 requests/hour

## Cache strategy

Emoji generation exposes a deterministic cache key:

```ts
getEmojiGenerationCacheKey(productName, description);
```

The key includes `EMOJI_GENERATION_PROMPT_VERSION`, normalized product name, and normalized
description. The project does not persist generated image cache entries yet, but responses include
`cacheKey` and `promptVersion` so a durable cache can be added without changing route contracts.
