# batch-019

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-019.png`.

| Ячейка | Товар                  | English          | Категория | Действие |
| ------ | ---------------------- | ---------------- | --------- | -------- |
| 1      | Ополаскиватель для рта | Mouthwash        | Аптека    | новый    |
| 2      | Шампунь                | Shampoo          | Косметика | новый    |
| 3      | Бальзам для волос      | Hair conditioner | Косметика | новый    |
| 4      | Гель для душа          | Shower gel       | Косметика | новый    |
| 5      | Дезодорант             | Deodorant        | Косметика | новый    |
| 6      | Пена для бритья        | Shaving foam     | Косметика | новый    |
| 7      | Помада                 | Lipstick         | Косметика | новый    |
| 8      | Тушь для ресниц        | Mascara          | Косметика | новый    |
| 9      | Солнцезащитный крем    | Sunscreen        | Косметика | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Ополаскиватель для рта» — mouthwash; 2) «Шампунь» — shampoo; 3) «Бальзам для волос» — hair conditioner
Row 2: 4) «Гель для душа» — shower gel; 5) «Дезодорант» — deodorant; 6) «Пена для бритья» — shaving foam
Row 3: 7) «Помада» — lipstick; 8) «Тушь для ресниц» — mascara; 9) «Солнцезащитный крем» — sunscreen
```
