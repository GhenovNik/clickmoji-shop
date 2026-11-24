# batch-012 — без надписей (одна версия на оба языка)

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-012.png`.

| Ячейка | Товар              | English           | Категория       | Действие |
| ------ | ------------------ | ----------------- | --------------- | -------- |
| 1      | Пакеты с застёжкой | Zip bags          | Товары для дома | новый    |
| 2      | Пергамент          | Baking paper      | Товары для дома | новый    |
| 3      | Спички             | Matches           | Товары для дома | новый    |
| 4      | Одноразовая посуда | Disposable plates | Товары для дома | новый    |
| 5      | Бинт               | Gauze roll        | Аптека          | новый    |
| 6      | Медицинские маски  | Face masks        | Аптека          | новый    |
| 7      | Зубная нить        | Dental floss      | Аптека          | новый    |
| 8      | Помада             | Lipstick          | Косметика       | новый    |
| 9      | Тушь для ресниц    | Mascara           | Косметика       | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose two or three items of the same group with the same lighting and simplification.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Пакеты с застёжкой» — zip bags; 2) «Пергамент» — baking paper; 3) «Спички» — matches
Row 2: 4) «Одноразовая посуда» — disposable plates; 5) «Бинт» — gauze roll; 6) «Медицинские маски» — face masks
Row 3: 7) «Зубная нить» — dental floss; 8) «Помада» — lipstick; 9) «Тушь для ресниц» — mascara
```
