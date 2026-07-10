# AI Features

AI is used for emoji generation and product automation. Providers can be switched by `AI_PROVIDER`.

## Providers

- Google GenAI SDK: Gemini (text), Imagen (image)
- OpenAI SDK: GPT Image (optional)

## Implemented flows

- Emoji generation: `POST /api/emoji/generate`
- Bulk import: `POST /api/products/bulk-import`
- Smart create: `POST /api/products/smart-create`
- Import list from free text: `POST /api/lists/import-text`

## Service boundaries

- Text/product automation lives in `src/lib/services/ai-products.ts`.
- Emoji image generation and UploadThing upload orchestration live in
  `src/lib/services/emoji-assets.ts`.
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
