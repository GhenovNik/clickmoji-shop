# batch-014

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-014.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-014-en.png`.

| Ячейка | Товар          | English         | Категория              | Действие |
| ------ | -------------- | --------------- | ---------------------- | -------- |
| 1      | Шпроты         | Sprats          | Консервы и готовая еда | новый    |
| 2      | Суши           | Sushi           | Консервы и готовая еда | новый    |
| 3      | Сэндвич        | Sandwich        | Консервы и готовая еда | новый    |
| 4      | Чипсы          | Potato chips    | Консервы и готовая еда | новый    |
| 5      | Крекеры        | Crackers        | Консервы и готовая еда | новый    |
| 6      | Наггетсы       | Chicken nuggets | Замороженные продукты  | новый    |
| 7      | Картофель фри  | French fries    | Замороженные продукты  | новый    |
| 8      | Котлеты        | Cutlets         | Замороженные продукты  | новый    |
| 9      | Рыбные палочки | Fish sticks     | Замороженные продукты  | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Шпроты» — an open tin of smoked sprats; 2) «Суши» — sushi; 3) «Сэндвич» — sandwich
Row 2: 4) «Чипсы» — potato chips; 5) «Крекеры» — crackers; 6) «Наггетсы» — chicken nuggets
Row 3: 7) «Картофель фри» — french fries; 8) «Котлеты» — cutlets; 9) «Рыбные палочки» — fish sticks
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Шпроты» → "Sprats"; 2) «Суши» → "Sushi"; 3) «Сэндвич» → "Sandwich"; 4) «Чипсы» → "Potato chips"; 5) «Крекеры» → "Crackers"; 6) «Наггетсы» → "Chicken nuggets"; 7) «Картофель фри» → "French fries"; 8) «Котлеты» → "Cutlets"; 9) «Рыбные палочки» → "Fish sticks"
```
