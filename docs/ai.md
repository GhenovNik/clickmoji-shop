# AI Features

AI is used for emoji generation and product automation. Providers can be switched by `AI_PROVIDER`.

## Providers

- Google GenAI SDK: Gemini (text), Imagen (image)
- OpenAI SDK: GPT Image (optional)

## Image model selection

The image model is configuration, not code. Every value below is the operator default from the
AGE-347 decision (2026-10-04); nothing has to be set in the environment to get a working service.

| Variable             | Unset / empty / whitespace    | Non-empty value (trimmed)                                                                     |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `GOOGLE_IMAGE_MODEL` | `gemini-3.1-flash-lite-image` | that model, routed by the id grammar below                                                    |
| `IMAGEN_MODEL`       | same default                  | deprecated synonym of `GOOGLE_IMAGE_MODEL`, read only when that one is unset/empty/whitespace |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2.5-flare`         | that model, validated against the GPT Image id grammar                                        |

Only the variables of the active provider (`AI_PROVIDER`) are read; the inactive provider's
variables are neither read nor validated, and importing the module with an invalid value does not
throw. An invalid value fails at generation time with a configuration error naming the variable and
its value, before any SDK call.

### Adapters

`AI_PROVIDER=gemini` (or anything that is not exactly `gpt-image`) resolves the Google id as the
first non-empty trimmed value of `GOOGLE_IMAGE_MODEL`, then `IMAGEN_MODEL`, then the default, and
picks the adapter by the id grammar (full match, no flags):

- `^imagen-[a-z0-9]+(?:[.-][a-z0-9]+)*$` → `models.generateImages`
- `^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*-image(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$` →
  `models.generateContent({ model, contents: prompt, config: { responseModalities: ['IMAGE'],
imageConfig: { aspectRatio: '1:1' } } })`
- anything else (`gemini-image`, `gemini-2.5-flash`, `dall-e-3`, `foo`, uppercase, spaces, newlines,
  `models/...`) → configuration error naming `GOOGLE_IMAGE_MODEL` or `IMAGEN_MODEL`

`AI_PROVIDER=gpt-image` validates the id against `^gpt-image-[a-z0-9]+(?:[.-][a-z0-9]+)*$` and then
calls `images.generate({ model, prompt, size: '1024x1024', quality: 'medium', background:
'transparent' })`, reading `data[0].b64_json`.

The grammar is a shape check, not a model catalogue: a matching id is routed, it does not guarantee
that the model can generate images. For OpenAI the model must support `images.generate` and return a
base64 PNG.

### Adapter error classes

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

The OpenAI adapter applies the same byte checks (`empty-image`, `invalid-png`, `too-large`) to the
decoded `data[0].b64_json`; a response without image data keeps the previous
`No image data from GPT Image` error. Each class is an `Error` whose text contains the class name
and never contains keys or response content. Classes are visible in the server log (through the
existing `console.error` of the callers) and are not exposed in HTTP responses. Exactly one adapter
call is made per generation: there is no fallback to another provider or model.

### Prompt variants and metadata

`src/lib/prompts/emoji-generation.ts` holds one template with two variants of the two white-field
lines. The Google path renders `emoji-image-v1` (unchanged: `lots of white padding` and `isolated
on pure white background (#FFFFFF)`); the OpenAI path renders `emoji-image-v1-transparent`, which
replaces both lines with `generous transparent padding, no background colour or fill` and `isolated
on a fully transparent background`. `promptVersion` and `cacheKey` follow the variant actually used;
the result fields, the route HTTP schemas and the upload path are unchanged.

## Comparing image providers

Price snapshot **2026-10-04**. Every row links the official page the value was read from; a value
that could not be confirmed from an official page is written as _unconfirmed_ rather than estimated.
Google prices are per 1000 images at 1K resolution and cover image output only; input tokens are
billed separately and are not in these numbers.

| Model                                               | Price per 1000 images at 1K                                                                                                                                                                                                                                                                           | Transparent background                                                                   | Limits (scope)                                                                                                                                                                 | Free image API tier                                                                                                                                           | Status and shutdown                                                                                           | Source                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini-3.1-flash-lite-image` (Google, **default**) | Standard **$33.60** ($0.0336 per image, image output $30 per 1M output tokens); Batch **$16.80** ($0.0168, $15 per 1M). Input billed separately: $0.25 per 1M tokens Standard, $0.125 Batch                                                                                                           | No — white background only in the prompt, background removal would be a separate feature | Per project, not per API key; IPM applies to Nano Banana models, the numeric value depends on the project tier and is not published; Tier 1 requires an active billing account | No — pricing page shows Free Tier "Not available" for input and output                                                                                        | Stable, **no announced shutdown date**                                                                        | [pricing](https://ai.google.dev/gemini-api/docs/pricing), [image generation](https://ai.google.dev/gemini-api/docs/image-generation), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [models](https://ai.google.dev/gemini-api/docs/models)                                                                                                                      |
| `gemini-3.1-flash-image` (Google)                   | Standard **$67.00** at 1K ($0.067 per image; $0.045 at 0.5K, $0.101 at 2K, $0.151 at 4K; image output $60 per 1M); Batch **$34.00** at 1K ($0.034). Input billed separately: $0.50 per 1M tokens Standard, $0.25 Batch                                                                                | No, same as above                                                                        | Same per-project IPM scope; not published as a fixed number                                                                                                                    | No — Free Tier "Not available"                                                                                                                                | Stable, **no announced shutdown date**; Google recommends it as the `imagen-4.0-*` replacement                | [pricing](https://ai.google.dev/gemini-api/docs/pricing), [image generation](https://ai.google.dev/gemini-api/docs/image-generation), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)                                                                                                                                                                              |
| `gpt-image-2.5-flare` (OpenAI, **default**)         | No official per-image price. Token rates per 1M: image output **$30** (Batch $15), image input **$8** (Batch $4), text input **$5** (Batch $2.50). The docs state that GPT Image 2 calculator output does not estimate GPT Image 2.5 consumption, so a per-image figure must be measured from `usage` | Yes — `background: 'transparent'` with PNG output                                        | Per organization and usage tier: IPM **5** (Tier 1), 20, 50, 150, 250; Tier 1 needs $5 paid                                                                                    | Unconfirmed: the Image API pages and the pricing page state no free image rate, but no page says "image API is unavailable on the free tier" in so many words | Stable, **no announced shutdown date**; replacement recommended for the retired GPT Image 1 models            | [model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare), [pricing](https://developers.openai.com/api/docs/pricing), [image generation guide](https://developers.openai.com/api/docs/guides/image-generation), [rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [deprecations](https://developers.openai.com/api/docs/deprecations) |
| `gpt-image-1.5` (OpenAI)                            | Not listed on the pricing page (no price per image, no token rate row)                                                                                                                                                                                                                                | Yes, same parameter                                                                      | Same IPM scope, per organization tier                                                                                                                                          | Same as above                                                                                                                                                 | Deprecated 2026-06-02, **shutdown 2026-12-01**; replacement `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare` | [deprecations](https://developers.openai.com/api/docs/deprecations), [pricing](https://developers.openai.com/api/docs/pricing)                                                                                                                                                                                                                                                      |

Retired for reference: the whole `imagen-4.0-*` family (including `imagen-4.0-generate-001` and
`imagen-4.0-fast-generate-001`) was released 2025-06-24 and **shut down 2026-08-17**, with
`gemini-3.1-flash-image` as the recommended replacement — source
[Gemini API deprecations](https://ai.google.dev/gemini-api/docs/deprecations).

No permanent free image API exists on either side. A Google AI Pro subscription is a separate thing
from API billing: the plan page advertises "$10 in monthly Google Cloud credits from Google Developer
Program" ([plans](https://one.google.com/about/google-ai-plans/)), while the API billing page states
that eligible Google Cloud credits are consumed only after a positive Prepay balance exists
([billing](https://ai.google.dev/gemini-api/docs/billing)). At the Lite price $10 of image output
would be about 297 images — that is arithmetic, not a quota, and whether those credits can be used
for this project is unconfirmed. ChatGPT subscriptions are billed separately from the OpenAI API and
do not pay for server-side API calls.

## Known limitations

- **No transparent background on Google.** The Gemini image models have no transparent-background
  parameter; the image generation guide asks for a white background in the prompt, which is what the
  Google prompt variant does. Emoji from the Google branch therefore carry a white field.
  Background removal is deliberately out of scope for this change.
- **No free image API tier** on either provider (see the table), so generation always costs money.
- **Google response filtering.** A blocked or filtered response is a soft failure: the adapter turns
  `finishReason` and `blockReason` into named error classes instead of retrying, and the caller
  degrades to a Unicode emoji in smart-create.
- **Route limits are not provider admission control.** `POST /api/emoji/generate` allows 20 requests
  per hour per user; OpenAI Tier 1 allows 5 images per minute for the whole organization, so
  concurrent load can return 429 from the provider. Shared budget, queueing and concurrency are a
  follow-up before a real multi-user launch.
- **Cost and time ceiling.** One adapter call per generation, with the SDK's own internal retries and
  timeouts unchanged; an explicit time/cost limit is a follow-up.

## Switching, rollback and the paid probe

Switching:

1. Pick the model and check its id against the grammar above.
2. Set `GOOGLE_IMAGE_MODEL` or `OPENAI_IMAGE_MODEL` in the Vercel environment (see `docs/ops.md`).
3. Redeploy. No code release is needed.
4. Generate one emoji manually and read the server log: success, or a named adapter error class.

Three different actions, not interchangeable:

1. **Roll back the configuration** — before any env change, write down the previous values and whether
   each of `AI_PROVIDER`, `GOOGLE_IMAGE_MODEL`, `IMAGEN_MODEL` and `OPENAI_IMAGE_MODEL` was present
   (no secrets). To roll back, restore exactly those values and redeploy.
2. **Return to the default** — delete the override variable and redeploy. This is not a rollback: it
   lands on the current defaults, `gemini-3.1-flash-lite-image` or `gpt-image-2.5-flare`.
3. **Roll back the code** — revert the squash commit and redeploy. That restores the previous
   `imagen-4.0-generate-001` default, which Google has already retired, so it does not promise a
   working generation path.

### Paid probe result (AC-12)

Probe harness and dry run: `~/.local/share/dev-harness/artifacts/AGE-347/probe/` (`probe.ts`,
`README.md`), log `probe-log-dry-run.json`, console transcript `probe-dry-run-console.txt`, both
against the branch SHA recorded in the log manifest.

- Dry run (fake transport, synthetic key, no paid call): **PASS** for both providers — one attempt
  each, one HTTP request per attempt (no retries), real SDK request bodies matching FR-1/FR-8,
  both negative controls rejected, synthetic marker absent from the log.
- Paid run (at most 3 attempts per provider, real provider key, artifacts under
  `~/.local/share/dev-harness/artifacts/AGE-347/visual/`): **PLACEHOLDER — the coordinator runs this
  stage.** Nothing in this table is a measurement until `probe-log.json` and the per-provider PNGs
  from that run are in place; OpenAI cost stays _not measured_ until the `usage` block of a real
  response is recorded.

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
`src/lib/prompts/emoji-generation.ts` and versioned: `EMOJI_GENERATION_PROMPT_VERSION`
(`emoji-image-v1`) for Google and `EMOJI_GENERATION_TRANSPARENT_PROMPT_VERSION`
(`emoji-image-v1-transparent`) for OpenAI. See "Prompt variants and metadata" above.

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
