# batch-008 — без надписей (одна версия на оба языка)

Уже сгенерирована. Ячейки с надписями перерисовываются в текстовых пачках: здесь их картинка остаётся только в библиотеке.

| Ячейка | Товар           | English        | Категория              | Действие |
| ------ | --------------- | -------------- | ---------------------- | -------- |
| 1      | Баранина        | Lamb           | Мясо и мясные продукты | новый    |
| 2      | Утка            | Duck           | Мясо и мясные продукты | новый    |
| 3      | Куриные крылья  | Chicken wings  | Мясо и мясные продукты | новый    |
| 4      | Куриное филе    | Chicken breast | Мясо и мясные продукты | новый    |
| 5      | Ветчина         | Ham            | Мясо и мясные продукты | новый    |
| 6      | Салями          | Salami         | Мясо и мясные продукты | новый    |
| 7      | Варёная колбаса | Bologna        | Мясо и мясные продукты | новый    |
| 8      | Печень          | Liver          | Мясо и мясные продукты | новый    |
| 9      | Форель          | Trout          | Рыба и морепродукты    | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
NO text at all: no letters, words, numbers or logos anywhere, not even on packaging.

Cells, left to right, top to bottom:
Row 1: 1) «Баранина» — lamb; 2) «Утка» — duck; 3) «Куриные крылья» — chicken wings
Row 2: 4) «Куриное филе» — chicken breast; 5) «Ветчина» — ham; 6) «Салями» — salami
Row 3: 7) «Варёная колбаса» — a pink boiled sausage with a slice cut; 8) «Печень» — liver; 9) «Форель» — trout
```
