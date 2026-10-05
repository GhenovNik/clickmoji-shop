# AI Features

AI is used for emoji generation and product automation. Providers can be switched by `AI_PROVIDER`.

## Providers

- Google GenAI SDK: Gemini (text and image output); the retired `imagen-4.0-*` family is still
  reachable only through the legacy `models.generateImages` adapter
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

### Provider unavailability

When the provider itself cannot serve the request, the service throws a typed
`EmojiProviderUnavailableError` (`src/lib/services/emoji-errors.ts`) with `name`,
`code: 'image_provider_unavailable'`, `reason`, `provider` and the resolved `model`. It carries
neither the SDK error nor its message, body, headers or `cause`.

| `reason`      | Recognized from                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing-key` | `GOOGLE_GENAI_API_KEY` / `OPENAI_API_KEY` unset, empty or whitespace only. No SDK client is created, so there are 0 SDK calls and 0 uploads |
| `quota`       | HTTP 429, `RESOURCE_EXHAUSTED`, `insufficient_quota`, `rate_limit_exceeded`                                                                 |
| `auth`        | HTTP 401 or 403, `UNAUTHENTICATED`, `PERMISSION_DENIED`, and a Google HTTP 400 whose body carries `API_KEY_INVALID`                         |

The Google SDK reports a status in the message text when its retry layer is active, so
`Retryable HTTP Error: Too Many Requests` and `Non-retryable exception Unauthorized|Forbidden sending
request` are recognized as a fallback for a missing numeric status. Everything else keeps the previous
error and the previous HTTP response: a plain 400 / `INVALID_ARGUMENT`, a 500, a network failure, an
invalid model id (a configuration error naming the variable) and every error class above. There is no
retry of our own and no fallback to the other provider or model.

What a caller sees:

- `POST /api/emoji/generate` answers **503** with
  `{ "error": "AI image generation is unavailable right now (provider quota or API key). Pick a regular emoji instead.", "code": "image_provider_unavailable" }`.
  The admin UI shows that `error` text in its existing alert; no UI code changed. Any other
  generation failure still answers the previous 500 `{ "error": "Failed to generate emoji" }`.
- `POST /api/products/smart-create` treats it like any other generation failure: the product is
  created with the Unicode emoji, `isCustom=false`, `imageUrl=null`, the response reports
  `customEmojiGenerated=false`, and no upload is started.

Server logs of a generation failure carry an allowlisted record only — error class, `reason`, HTTP
status, provider and resolved model. The class is read from the typed error the service raises
(`EmojiProviderUnavailableError`, or the FR-3 / `configuration` kind of `EmojiImageGenerationError`);
an error the service did not create has no class of ours and is reported as `Error` with its HTTP
status if the SDK exposes one. The class is never guessed from a substring of a message, so an
upstream error that happens to say "blocked" stays a plain failure. The raw SDK message, body,
headers and `cause` are never passed to `console.error` for a generation failure, and the HTTP body
never carries them either.

A failure outside image generation — a Prisma write, the product text analysis or the parsing of the
request body — is not a generation failure, and no provider error can reach that log: the
`catch` around the generation call in `POST /api/emoji/generate` and the one around
`generateAndUploadEmojiAsset` in smart-create handle those. Such a failure is logged with its class
and message, as before.

### Prompt variants and metadata

`src/lib/prompts/emoji-generation.ts` holds one template with two variants of the two white-field
lines. The Google path renders `emoji-image-v1` (unchanged: `lots of white padding` and `isolated
on pure white background (#FFFFFF)`); the OpenAI path renders `emoji-image-v1-transparent`, which
replaces both lines with `generous transparent padding, no background colour or fill` and `isolated
on a fully transparent background`. `promptVersion` and `cacheKey` follow the variant actually used;
the result fields, the route HTTP schemas and the upload path are unchanged.

## Comparing image providers

Price snapshot **2026-10-04**. Every row links the official page the value was read from; a value
that is not in the research snapshot and was not read from such a page is written as
_unconfirmed (2026-10-04)_ rather than estimated. Google prices are per 1000 images at 1K resolution
and cover image output only; input tokens are billed separately and are not in these numbers.

| Model                                               | Price per 1000 images at 1K                                                                                                                                                                                                                                                                                                           | Transparent background                                                                   | Limits (scope)                                                                                                                                                                 | Free image API tier                                                                                            | Status and shutdown                                                                                           | Source                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini-3.1-flash-lite-image` (Google, **default**) | Standard **$33.60** ($0.0336 per image, image output $30 per 1M output tokens); Batch **$16.80** ($0.0168, $15 per 1M). Input tokens are billed separately; their rate is unconfirmed (2026-10-04)                                                                                                                                    | No — white background only in the prompt, background removal would be a separate feature | Per project, not per API key; IPM applies to Nano Banana models, the numeric value depends on the project tier and is not published; Tier 1 requires an active billing account | No — pricing page shows Free Tier "Not available" for input and output                                         | Stable, **no announced shutdown date**                                                                        | [pricing](https://ai.google.dev/gemini-api/docs/pricing), [image generation](https://ai.google.dev/gemini-api/docs/image-generation), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [models](https://ai.google.dev/gemini-api/docs/models)                                                                                                                      |
| `gemini-3.1-flash-image` (Google)                   | Standard **$67.00** at 1K ($0.067 per image; $0.045 at 0.5K, $0.101 at 2K, $0.151 at 4K; image output $60 per 1M); Batch **$34.00** at 1K ($0.034). Input tokens are billed separately; their rate is unconfirmed (2026-10-04)                                                                                                        | No, same as above                                                                        | Same per-project IPM scope; not published as a fixed number                                                                                                                    | No — Free Tier "Not available"                                                                                 | Stable, **no announced shutdown date**; Google recommends it as the `imagen-4.0-*` replacement                | [pricing](https://ai.google.dev/gemini-api/docs/pricing), [image generation](https://ai.google.dev/gemini-api/docs/image-generation), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)                                                                                                                                                                              |
| `gpt-image-2.5-flare` (OpenAI, **default**)         | No official per-image price. Token rates per 1M: image output **$30** (Batch $15), image input **$8** (text input **$5**); both input rates in Batch are unconfirmed (2026-10-04). The docs state that GPT Image 2 calculator output does not estimate GPT Image 2.5 consumption, so a per-image figure must be measured from `usage` | Yes — `background: 'transparent'` with PNG output                                        | Per organization and usage tier: IPM **5** (Tier 1), 20, 50, 150, 250; a paid purchase on Tier 1 is unconfirmed (2026-10-04)                                                   | No — the docs state the free tier is not supported and ask for a credit balance (research snapshot 2026-10-04) | Stable, **no announced shutdown date**; replacement recommended for the retired GPT Image 1 models            | [model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare), [pricing](https://developers.openai.com/api/docs/pricing), [image generation guide](https://developers.openai.com/api/docs/guides/image-generation), [rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [deprecations](https://developers.openai.com/api/docs/deprecations) |
| `gpt-image-1.5` (OpenAI)                            | unconfirmed (2026-10-04) — the research snapshot records no price for this model                                                                                                                                                                                                                                                      | Yes, the same `background` parameter — unconfirmed (2026-10-04) for this model           | Same per-organization IPM scope — unconfirmed (2026-10-04) for this model                                                                                                      | No, as above — unconfirmed (2026-10-04) for this model                                                         | Deprecated 2026-06-02, **shutdown 2026-12-01**; replacement `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare` | [deprecations](https://developers.openai.com/api/docs/deprecations), [pricing](https://developers.openai.com/api/docs/pricing)                                                                                                                                                                                                                                                      |

Retired for reference: the whole `imagen-4.0-*` family (including `imagen-4.0-generate-001` and
`imagen-4.0-fast-generate-001`) was released 2025-06-24 and **shut down 2026-08-17**, with
`gemini-3.1-flash-image` as the recommended replacement — source
[Gemini API deprecations](https://ai.google.dev/gemini-api/docs/deprecations).

A value marked _unconfirmed (2026-10-04)_ is not in the AGE-347 research snapshot
(`research/AGE-347-imagen-migration.md` and `image-api-research-poco-2026-10-04.txt`) and was not
read from the official page while this comparison was corrected; no provider API was called. Check
such a value on the page in its Source column before using it in a decision.

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
- **The Google key has no image quota yet.** The key in production answered `429` on both paid probe
  attempts, so the project most likely has no billing or no image quota for it. Until the operator
  enables billing, the Google branch cannot generate: the generate route answers the 503
  `image_provider_unavailable` body and smart-create creates the product with a Unicode emoji.
  The live response of the Lite branch was therefore never observed; if it answers anything other
  than `image/png` (FR-3 accepts no other mime type), every generation ends with the
  `unsupported-format` class — check `inlineData.mimeType` on the first live generation after
  billing is enabled.
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
  all negative controls rejected, synthetic marker absent from the log
  (`probe-log-dry-run.json`, `probe-dry-run-console.txt`).
- Paid run, OpenAI `gpt-image-2.5-flare`, 1 of 3 attempts: **PASS**. 1024x1024, alpha channel,
  0 of 8176 opaque border samples, no near-white opaque pixels in the mid ring, 32.8% opaque pixels
  as the subject, 867 374 bytes in 11.2 s, `returnedModel = gpt-image-2.5-flare`,
  `promptVersion = emoji-image-v1-transparent`, sha256 `bd1d747c…` (`probe/out/probe-log.json`,
  `visual/probe-openai-1.png`, `visual/probe-openai-1-on-magenta.png`). Inspection on the magenta
  backdrop confirmed transparency around the silhouette and no white plate or painted checkerboard.
  The harness recorded `FAIL-image-validation` for this attempt because of its own
  `no-plate-in-mid-ring` heuristic, which is not part of the spec: it measured 18.9% opaque at the
  0.18 inset while the subject is large (bbox y 121-919) and crosses that ring. Every criterion the
  spec does list passed. Cost: **not measured** — the response carried no recorded `usage` block.
- Paid run, Google `gemini-3.1-flash-lite-image`, 2 of 3 attempts: **FAIL without generation and
  without a charge**. Both `generateContent` calls answered `429 Too Many Requests` in ~260-280 ms;
  the model itself exists (`GET models` → 200). Per protocol a 429 is an unclear outcome, so the
  Google run was stopped there. The Google attempt wrote no artifact: `probe/out/probe-gemini-1.png`
  is the dry-run fake-transport image (23 102 bytes, sha256 `22396318…`), not a Google generation.
- The probe is **closed**: the operator decided on 2026-10-04 not to enable Google billing, not to
  change the Vercel environment and not to run further live probes. The Google `generateContent` path
  therefore stays unproven against the live API, and mocks in the test suite are its evidence.

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
- Provider unavailability (`EmojiProviderUnavailableError`, its classification and the allowlisted
  log record) lives in `src/lib/services/emoji-errors.ts`.
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

The key includes the prompt version actually used — `emoji-image-v1` on the Google branch,
`emoji-image-v1-transparent` on the OpenAI one — plus the normalized product name and the normalized
description. The project does not persist generated image cache entries yet, but responses include
`cacheKey` and `promptVersion` so a durable cache can be added without changing route contracts.
