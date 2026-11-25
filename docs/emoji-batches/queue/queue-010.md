# queue-010 — без надписей (одна версия на оба языка)

Новый чат в Gemini. Приложить все четыре образца из `docs/emoji-batches/style-refs/` (`zucchini.webp`, `lentils.webp`, `honey.webp`, `kefir.webp`). Вставить промпт и сохранить картинку как `queue-010.png`.

| Ячейка | Цель                   | English             | Каталог                | Тип       | Действие       |
| ------ | ---------------------- | ------------------- | ---------------------- | --------- | -------------- |
| 1      | Консервы и готовая еда | Canned & Ready Food | Консервы и готовая еда | категория | новая картинка |
| 2      | Бытовая химия          | Household Chemicals | Бытовая химия          | категория | новая картинка |
| 3      | Товары для дома        | Home Goods          | Товары для дома        | категория | новая картинка |
| 4      | Аптека                 | Pharmacy            | Аптека                 | категория | новая картинка |
| 5      | Косметика              | Cosmetics           | Косметика              | категория | новая картинка |
| 6      | Сладости               | Sweets              | Сладости               | категория | новая картинка |
| 7      | Замороженные продукты  | Frozen              | Замороженные продукты  | категория | новая картинка |
| 8      | Детское питание        | Baby Food           | Детское питание        | категория | новая картинка |
| 9      | Корм для животных      | Pet Food            | Корм для животных      | категория | новая картинка |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose exactly three of the most recognizable items of the same group, in one single composition, with the same lighting and simplification as the other cells.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Консервы и готовая еда» — exactly three most recognizable ready-to-eat dishes or cans together in one composition; 2) «Бытовая химия» — exactly three most recognizable household cleaning items together in one composition; 3) «Товары для дома» — exactly three most recognizable household items together in one composition
Row 2: 4) «Аптека» — exactly three most recognizable pharmacy items together in one composition; 5) «Косметика» — exactly three most recognizable cosmetic items together in one composition; 6) «Сладости» — exactly three most recognizable sweets together in one composition
Row 3: 7) «Замороженные продукты» — exactly three most recognizable frozen foods together in one composition; 8) «Детское питание» — exactly three most recognizable baby food items together in one composition; 9) «Корм для животных» — exactly three most recognizable pet food items together in one composition
```
