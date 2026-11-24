# batch-001 — без надписей (одна версия на оба языка)

Уже сгенерирована. Ячейки с надписями перерисовываются в текстовых пачках: здесь их картинка остаётся только в библиотеке.

| Ячейка | Товар | English | Категория | Действие |
|---|---|---|---|---|
| 1 | Кабачок | Zucchini | Овощи | картинка для существующего |
| 2 | Чечевица | Lentils | Овощи | картинка для существующего |
| 3 | Миндальное масло | Almond butter | Орехи и Сухофрукты | перерисовывается в text-001 |
| 4 | Льняное семя | Flaxseed | Орехи и Сухофрукты | картинка для существующего |
| 5 | Тыква | Pumpkin | Овощи | новый |
| 6 | Петрушка | Parsley | Овощи | новый |
| 7 | Укроп | Dill | Овощи | новый |
| 8 | Кинза | Cilantro | Овощи | новый |
| 9 | Мята | Mint | Овощи | новый |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose two or three items of the same group with the same lighting and simplification.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Кабачок» — a light-green zucchini, not a cucumber; 2) «Чечевица» — a small pile of orange lentils; 3) «Миндальное масло» — an open jar of almond butter with an almond beside it
Row 2: 4) «Льняное семя» — a small pile of shiny brown flax seeds; 5) «Тыква» — pumpkin; 6) «Петрушка» — a bunch of flat-leaf parsley
Row 3: 7) «Укроп» — a bunch of feathery dill; 8) «Кинза» — a bunch of cilantro; 9) «Мята» — a sprig of fresh mint
```
