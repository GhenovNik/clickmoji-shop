# batch-009

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-009.png`.

| Ячейка | Товар            | English       | Категория           | Действие |
| ------ | ---------------- | ------------- | ------------------- | -------- |
| 1      | Скумбрия         | Mackerel      | Рыба и морепродукты | новый    |
| 2      | Сардины          | Sardines      | Рыба и морепродукты | новый    |
| 3      | Минтай           | Pollock       | Рыба и морепродукты | новый    |
| 4      | Тилапия          | Tilapia       | Рыба и морепродукты | новый    |
| 5      | Крабовые палочки | Crab sticks   | Рыба и морепродукты | новый    |
| 6      | Устрицы          | Oysters       | Рыба и морепродукты | новый    |
| 7      | Морская капуста  | Seaweed salad | Рыба и морепродукты | новый    |
| 8      | Булгур           | Bulgur        | Крупы и макароны    | новый    |
| 9      | Кускус           | Couscous      | Крупы и макароны    | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Скумбрия» — mackerel; 2) «Сардины» — sardines; 3) «Минтай» — pollock
Row 2: 4) «Тилапия» — tilapia; 5) «Крабовые палочки» — crab sticks; 6) «Устрицы» — oysters
Row 3: 7) «Морская капуста» — seaweed salad; 8) «Булгур» — bulgur; 9) «Кускус» — couscous
```
