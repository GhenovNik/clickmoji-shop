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

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Питахайя» — dragon fruit; 2) «Фейхоа» — feijoa; 3) «Кефир» — a white carton of kefir
Row 2: 4) «Ряженка» — a glass bottle of creamy beige baked milk; 5) «Сливки» — a small carton of cream; 6) «Моцарелла» — white mozzarella balls
Row 3: 7) «Пармезан» — a wedge of hard parmesan; 8) «Плавленый сыр» — a round box of cheese wedges; 9) «Глазированный сырок» — a small chocolate-glazed curd bar
```
