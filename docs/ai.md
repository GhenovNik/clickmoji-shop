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

## Prompt style (current)

Emoji icons are generated in a flat, clean, vector-like style. Prompts are centralized in the emoji generation route and should remain versioned once prompt history is tracked.

## Planned improvements

- Rate limiting for AI endpoints
- Caching by product name + prompt version
- Prompt versioning for reproducibility
