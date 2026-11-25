# queue-011 — без надписей (одна версия на оба языка)

Новый чат в Gemini. Приложить все четыре образца из `docs/emoji-batches/style-refs/` (`zucchini.webp`, `lentils.webp`, `honey.webp`, `kefir.webp`). Вставить промпт и сохранить картинку как `queue-011.png`.

| Ячейка | Цель                | English             | Каталог             | Тип       | Действие                                      |
| ------ | ------------------- | ------------------- | ------------------- | --------- | --------------------------------------------- |
| 1      | Напитки             | Beverages           | Напитки             | категория | замена картинки (старый URL в --replace-auth) |
| 2      | Крупы и макароны    | Grains & Pasta      | Крупы и макароны    | категория | замена картинки (старый URL в --replace-auth) |
| 3      | Орехи и Сухофрукты  | Nuts & Dried Fruits | Орехи и Сухофрукты  | категория | замена картинки (старый URL в --replace-auth) |
| 4      | Масла и соусы       | Oils & Sauces       | Масла и соусы       | категория | замена картинки (старый URL в --replace-auth) |
| 5      | Рыба и морепродукты | Fish & Seafood      | Рыба и морепродукты | категория | замена картинки (старый URL в --replace-auth) |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose exactly three of the most recognizable items of the same group, in one single composition, with the same lighting and simplification as the other cells.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
Only cells 1–5 hold an icon. Every other cell stays completely empty white: do not repeat, copy or add any icon there.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Напитки» — exactly three most recognizable drinks together in one composition; 2) «Крупы и макароны» — exactly three most recognizable grains or pasta together in one composition; 3) «Орехи и Сухофрукты» — exactly three most recognizable nuts or dried fruits together in one composition
Row 2: 4) «Масла и соусы» — exactly three most recognizable oils or sauces together in one composition; 5) «Рыба и морепродукты» — exactly three most recognizable fish or seafood together in one composition
```
