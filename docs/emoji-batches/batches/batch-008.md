# batch-008

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-008.png`.

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
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Баранина» — lamb; 2) «Утка» — duck; 3) «Куриные крылья» — chicken wings
Row 2: 4) «Куриное филе» — chicken breast; 5) «Ветчина» — ham; 6) «Салями» — salami
Row 3: 7) «Варёная колбаса» — a pink boiled sausage with a slice cut; 8) «Печень» — liver; 9) «Форель» — trout
```
