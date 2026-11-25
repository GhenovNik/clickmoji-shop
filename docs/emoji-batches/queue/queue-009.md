# queue-009 — без надписей (одна версия на оба языка)

Новый чат в Gemini. Приложить все четыре образца из `docs/emoji-batches/style-refs/` (`zucchini.webp`, `lentils.webp`, `honey.webp`, `kefir.webp`). Вставить промпт и сохранить картинку как `queue-009.png`.

| Ячейка | Цель                   | English        | Каталог                | Тип       | Действие       |
| ------ | ---------------------- | -------------- | ---------------------- | --------- | -------------- |
| 1      | Лобстер                | Lobster        | Рыба и морепродукты    | товар     | новая картинка |
| 2      | Мидии                  | Mussels        | Рыба и морепродукты    | товар     | новая картинка |
| 3      | Осьминог               | Octopus        | Рыба и морепродукты    | товар     | новая картинка |
| 4      | Рыба                   | Fish           | Рыба и морепродукты    | товар     | новая картинка |
| 5      | Овощи                  | Vegetables     | Овощи                  | категория | новая картинка |
| 6      | Фрукты                 | Fruits         | Фрукты                 | категория | новая картинка |
| 7      | Молочные продукты      | Dairy          | Молочные продукты      | категория | новая картинка |
| 8      | Хлеб и выпечка         | Bread & Bakery | Хлеб и выпечка         | категория | новая картинка |
| 9      | Мясо и мясные продукты | Meat           | Мясо и мясные продукты | категория | новая картинка |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose exactly three of the most recognizable items of the same group, in one single composition, with the same lighting and simplification as the other cells.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Лобстер» — lobster; 2) «Мидии» — mussels; 3) «Осьминог» — octopus
Row 2: 4) «Рыба» — fish; 5) «Овощи» — exactly three most recognizable vegetables together in one composition; 6) «Фрукты» — exactly three most recognizable fruits together in one composition
Row 3: 7) «Молочные продукты» — exactly three most recognizable dairy items together in one composition; 8) «Хлеб и выпечка» — exactly three most recognizable bakery items together in one composition; 9) «Мясо и мясные продукты» — exactly three most recognizable cuts or pieces of meat together in one composition
```
