# queue-009 — без надписей (одна версия на оба языка)

Новый чат в Gemini. Приложить все четыре образца из `docs/emoji-batches/style-refs/` (`zucchini.webp`, `lentils.webp`, `honey.webp`, `kefir.webp`). Вставить промпт и сохранить картинку как `queue-009.png`.

| Ячейка | Цель                   | English        | Каталог                | Тип       |
| ------ | ---------------------- | -------------- | ---------------------- | --------- |
| 1      | Лобстер                | Lobster        | Рыба и морепродукты    | товар     |
| 2      | Мидии                  | Mussels        | Рыба и морепродукты    | товар     |
| 3      | Осьминог               | Octopus        | Рыба и морепродукты    | товар     |
| 4      | Рыба                   | Fish           | Рыба и морепродукты    | товар     |
| 5      | Овощи                  | Vegetables     | Овощи                  | категория |
| 6      | Фрукты                 | Fruits         | Фрукты                 | категория |
| 7      | Молочные продукты      | Dairy          | Молочные продукты      | категория |
| 8      | Хлеб и выпечка         | Bread & Bakery | Хлеб и выпечка         | категория |
| 9      | Мясо и мясные продукты | Meat           | Мясо и мясные продукты | категория |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose two or three items of the same group with the same lighting and simplification.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Лобстер» — lobster; 2) «Мидии» — mussels; 3) «Осьминог» — octopus
Row 2: 4) «Рыба» — fish; 5) «Овощи» — two or three typical vegetables together; 6) «Фрукты» — two or three typical fruits together
Row 3: 7) «Молочные продукты» — two or three dairy items together; 8) «Хлеб и выпечка» — two or three bakery items together; 9) «Мясо и мясные продукты» — two or three cuts or pieces of meat together
```
