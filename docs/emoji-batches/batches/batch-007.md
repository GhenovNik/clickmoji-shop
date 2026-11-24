# batch-007 — без надписей (одна версия на оба языка)

Уже сгенерирована. Ячейки с надписями перерисовываются в текстовых пачках: здесь их картинка остаётся только в библиотеке.

| Ячейка | Товар | English | Категория | Действие |
|---|---|---|---|---|
| 1 | Тортилья | Tortillas | Хлеб и выпечка | перерисовывается в text-001 |
| 2 | Булочки для бургеров | Burger buns | Хлеб и выпечка | перерисовывается в text-002 |
| 3 | Хлебцы | Crispbread | Хлеб и выпечка | перерисовывается в text-002 |
| 4 | Пончик | Donut | Хлеб и выпечка | новый |
| 5 | Маффин | Muffin | Хлеб и выпечка | новый |
| 6 | Сушки | Sushki | Хлеб и выпечка | новый |
| 7 | Пирог | Pie | Хлеб и выпечка | новый |
| 8 | Фарш | Ground meat | Мясо и мясные продукты | новый |
| 9 | Индейка | Turkey | Мясо и мясные продукты | новый |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose two or three items of the same group with the same lighting and simplification.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Тортилья» — tortillas; 2) «Булочки для бургеров» — burger buns; 3) «Хлебцы» — crispbread
Row 2: 4) «Пончик» — donut; 5) «Маффин» — muffin; 6) «Сушки» — a few small crunchy bread rings
Row 3: 7) «Пирог» — pie; 8) «Фарш» — ground meat; 9) «Индейка» — turkey
```
