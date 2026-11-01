# batch-007

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-007.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-007-en.png`.

| Ячейка | Товар                | English     | Категория              | Действие |
| ------ | -------------------- | ----------- | ---------------------- | -------- |
| 1      | Тортилья             | Tortillas   | Хлеб и выпечка         | новый    |
| 2      | Булочки для бургеров | Burger buns | Хлеб и выпечка         | новый    |
| 3      | Хлебцы               | Crispbread  | Хлеб и выпечка         | новый    |
| 4      | Пончик               | Donut       | Хлеб и выпечка         | новый    |
| 5      | Маффин               | Muffin      | Хлеб и выпечка         | новый    |
| 6      | Сушки                | Sushki      | Хлеб и выпечка         | новый    |
| 7      | Пирог                | Pie         | Хлеб и выпечка         | новый    |
| 8      | Фарш                 | Ground meat | Мясо и мясные продукты | новый    |
| 9      | Индейка              | Turkey      | Мясо и мясные продукты | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Тортилья» — tortillas; 2) «Булочки для бургеров» — burger buns; 3) «Хлебцы» — crispbread
Row 2: 4) «Пончик» — donut; 5) «Маффин» — muffin; 6) «Сушки» — a few small crunchy bread rings
Row 3: 7) «Пирог» — pie; 8) «Фарш» — ground meat; 9) «Индейка» — turkey
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Тортилья» → "Tortillas"; 2) «Булочки для бургеров» → "Burger buns"; 3) «Хлебцы» → "Crispbread"; 4) «Пончик» → "Donut"; 5) «Маффин» → "Muffin"; 6) «Сушки» → "Sushki"; 7) «Пирог» → "Pie"; 8) «Фарш» → "Ground meat"; 9) «Индейка» → "Turkey"
```
