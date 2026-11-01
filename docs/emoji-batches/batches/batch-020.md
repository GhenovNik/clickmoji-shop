# batch-020

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-020.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-020-en.png`.

| Ячейка | Товар            | English          | Категория         | Действие |
| ------ | ---------------- | ---------------- | ----------------- | -------- |
| 1      | Крем для рук     | Hand cream       | Косметика         | новый    |
| 2      | Ватные диски     | Cotton pads      | Косметика         | новый    |
| 3      | Ватные палочки   | Cotton swabs     | Косметика         | новый    |
| 4      | Лак для ногтей   | Nail polish      | Косметика         | новый    |
| 5      | Подгузники       | Diapers          | Детское питание   | новый    |
| 6      | Детская вода     | Baby water       | Детское питание   | новый    |
| 7      | Детский творожок | Kids' curd snack | Детское питание   | новый    |
| 8      | Корм для рыбок   | Fish food        | Корм для животных | новый    |
| 9      | Корм для птиц    | Bird seed        | Корм для животных | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Крем для рук» — hand cream; 2) «Ватные диски» — cotton pads; 3) «Ватные палочки» — cotton swabs
Row 2: 4) «Лак для ногтей» — nail polish; 5) «Подгузники» — diapers; 6) «Детская вода» — baby water
Row 3: 7) «Детский творожок» — kids' curd snack; 8) «Корм для рыбок» — fish food; 9) «Корм для птиц» — bird seed
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Крем для рук» → "Hand cream"; 2) «Ватные диски» → "Cotton pads"; 3) «Ватные палочки» → "Cotton swabs"; 4) «Лак для ногтей» → "Nail polish"; 5) «Подгузники» → "Diapers"; 6) «Детская вода» → "Baby water"; 7) «Детский творожок» → "Kids' curd snack"; 8) «Корм для рыбок» → "Fish food"; 9) «Корм для птиц» → "Bird seed"
```
