# batch-015

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-015.png`.

| Ячейка | Товар            | English       | Категория             | Действие |
| ------ | ---------------- | ------------- | --------------------- | -------- |
| 1      | Лёд              | Ice           | Замороженные продукты | новый    |
| 2      | Квас             | Kvass         | Напитки               | новый    |
| 3      | Энергетик        | Energy drink  | Напитки               | новый    |
| 4      | Морс             | Berry drink   | Напитки               | новый    |
| 5      | Лимонад          | Lemonade      | Напитки               | новый    |
| 6      | Какао            | Cocoa         | Напитки               | новый    |
| 7      | Холодный чай     | Iced tea      | Напитки               | новый    |
| 8      | Апельсиновый сок | Orange juice  | Напитки               | новый    |
| 9      | Кокосовая вода   | Coconut water | Напитки               | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Лёд» — a bag of ice cubes; 2) «Квас» — a bottle of dark-amber kvass; 3) «Энергетик» — energy drink
Row 2: 4) «Морс» — a jug of red berry drink; 5) «Лимонад» — lemonade; 6) «Какао» — cocoa
Row 3: 7) «Холодный чай» — iced tea; 8) «Апельсиновый сок» — orange juice; 9) «Кокосовая вода» — coconut water
```
