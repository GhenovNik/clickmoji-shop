# batch-006 — без надписей (одна версия на оба языка)

Уже сгенерирована. Ячейки с надписями перерисовываются в текстовых пачках: здесь их картинка остаётся только в библиотеке.

| Ячейка | Товар            | English        | Категория         | Действие                    |
| ------ | ---------------- | -------------- | ----------------- | --------------------------- |
| 1      | Брынза           | Feta cheese    | Молочные продукты | новый                       |
| 2      | Творожный сыр    | Cream cheese   | Молочные продукты | перерисовывается в text-001 |
| 3      | Сгущённое молоко | Condensed milk | Молочные продукты | перерисовывается в text-001 |
| 4      | Греческий йогурт | Greek yogurt   | Молочные продукты | перерисовывается в text-001 |
| 5      | Овсяное молоко   | Oat milk       | Молочные продукты | перерисовывается в text-001 |
| 6      | Топлёное масло   | Ghee           | Молочные продукты | новый                       |
| 7      | Батон            | White loaf     | Хлеб и выпечка    | новый                       |
| 8      | Лаваш            | Lavash         | Хлеб и выпечка    | новый                       |
| 9      | Пита             | Pita bread     | Хлеб и выпечка    | новый                       |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Брынза» — a white block of feta; 2) «Творожный сыр» — a tub of cream cheese; 3) «Сгущённое молоко» — a tin of condensed milk
Row 2: 4) «Греческий йогурт» — greek yogurt; 5) «Овсяное молоко» — a carton of oat milk; 6) «Топлёное масло» — a glass jar of golden ghee
Row 3: 7) «Батон» — an oval Russian white loaf with diagonal cuts; 8) «Лаваш» — a folded thin flatbread; 9) «Пита» — pita bread
```
