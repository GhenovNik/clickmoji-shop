# queue-005 — без надписей (одна версия на оба языка)

Новый чат в Gemini. Приложить все четыре образца из `docs/emoji-batches/style-refs/` (`zucchini.webp`, `lentils.webp`, `honey.webp`, `kefir.webp`). Вставить промпт и сохранить картинку как `queue-005.png`.

| Ячейка | Цель          | English      | Каталог                | Тип            | Действие       |
| ------ | ------------- | ------------ | ---------------------- | -------------- | -------------- |
| 1      | Кекс          | Cupcake      | Хлеб и выпечка         | товар          | новая картинка |
| 2      | Крендель      | Pretzel      | Хлеб и выпечка         | товар          | новая картинка |
| 3      | Круассан      | Croissant    | Хлеб и выпечка         | товар          | новая картинка |
| 4      | Торт          | Cake         | Хлеб и выпечка         | товар          | новая картинка |
| 5      | Хлеб          | Bread        | Хлеб и выпечка         | товар          | новая картинка |
| 6      | Хлеб белый    | White bread  | Хлеб и выпечка         | вариант (Хлеб) | новая картинка |
| 7      | Говядина      | Beef         | Мясо и мясные продукты | товар          | новая картинка |
| 8      | Курица        | Chicken      | Мясо и мясные продукты | товар          | новая картинка |
| 9      | Мясо на кости | Meat on Bone | Мясо и мясные продукты | товар          | новая картинка |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose exactly three of the most recognizable items of the same group, in one single composition, with the same lighting and simplification as the other cells.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Кекс» — cupcake; 2) «Крендель» — pretzel; 3) «Круассан» — croissant
Row 2: 4) «Торт» — cake; 5) «Хлеб» — bread; 6) «Хлеб белый» — white bread
Row 3: 7) «Говядина» — beef; 8) «Курица» — chicken; 9) «Мясо на кости» — meat on bone
```
