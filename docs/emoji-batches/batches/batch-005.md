# batch-005 — без надписей (одна версия на оба языка)

Уже сгенерирована. Ячейки с надписями перерисовываются в текстовых пачках: здесь их картинка остаётся только в библиотеке.

| Ячейка | Товар               | English           | Категория         | Действие                    |
| ------ | ------------------- | ----------------- | ----------------- | --------------------------- |
| 1      | Питахайя            | Dragon fruit      | Фрукты            | новый                       |
| 2      | Фейхоа              | Feijoa            | Фрукты            | новый                       |
| 3      | Кефир               | Kefir             | Молочные продукты | перерисовывается в text-001 |
| 4      | Ряженка             | Ryazhenka         | Молочные продукты | перерисовывается в text-001 |
| 5      | Сливки              | Heavy cream       | Молочные продукты | перерисовывается в text-001 |
| 6      | Моцарелла           | Mozzarella        | Молочные продукты | новый                       |
| 7      | Пармезан            | Parmesan          | Молочные продукты | новый                       |
| 8      | Плавленый сыр       | Processed cheese  | Молочные продукты | новый                       |
| 9      | Глазированный сырок | Glazed curd snack | Молочные продукты | новый                       |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose two or three items of the same group with the same lighting and simplification.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Питахайя» — dragon fruit; 2) «Фейхоа» — feijoa; 3) «Кефир» — a white carton of kefir
Row 2: 4) «Ряженка» — a glass bottle of creamy beige baked milk; 5) «Сливки» — a small carton of cream; 6) «Моцарелла» — white mozzarella balls
Row 3: 7) «Пармезан» — a wedge of hard parmesan; 8) «Плавленый сыр» — a round box of cheese wedges; 9) «Глазированный сырок» — a small chocolate-glazed curd bar
```
