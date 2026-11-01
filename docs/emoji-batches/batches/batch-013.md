# batch-013

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-013.png`.

| Ячейка | Товар                     | English            | Категория              | Действие |
| ------ | ------------------------- | ------------------ | ---------------------- | -------- |
| 1      | Мёд                       | Honey              | Сладости               | новый    |
| 2      | Варенье                   | Jam                | Сладости               | новый    |
| 3      | Шоколадная паста          | Chocolate spread   | Сладости               | новый    |
| 4      | Жевательная резинка       | Chewing gum        | Сладости               | новый    |
| 5      | Попкорн                   | Popcorn            | Сладости               | новый    |
| 6      | Тушёнка                   | Canned stewed meat | Консервы и готовая еда | новый    |
| 7      | Консервированная кукуруза | Canned corn        | Консервы и готовая еда | новый    |
| 8      | Консервированный горошек  | Canned peas        | Консервы и готовая еда | новый    |
| 9      | Консервированная фасоль   | Canned beans       | Консервы и готовая еда | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Мёд» — honey; 2) «Варенье» — jam; 3) «Шоколадная паста» — chocolate spread
Row 2: 4) «Жевательная резинка» — chewing gum; 5) «Попкорн» — popcorn; 6) «Тушёнка» — canned stewed meat
Row 3: 7) «Консервированная кукуруза» — canned corn; 8) «Консервированный горошек» — canned peas; 9) «Консервированная фасоль» — canned beans
```
