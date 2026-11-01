# batch-006

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-006.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-006-en.png`.

| Ячейка | Товар            | English        | Категория         | Действие |
| ------ | ---------------- | -------------- | ----------------- | -------- |
| 1      | Брынза           | Feta cheese    | Молочные продукты | новый    |
| 2      | Творожный сыр    | Cream cheese   | Молочные продукты | новый    |
| 3      | Сгущённое молоко | Condensed milk | Молочные продукты | новый    |
| 4      | Греческий йогурт | Greek yogurt   | Молочные продукты | новый    |
| 5      | Овсяное молоко   | Oat milk       | Молочные продукты | новый    |
| 6      | Топлёное масло   | Ghee           | Молочные продукты | новый    |
| 7      | Батон            | White loaf     | Хлеб и выпечка    | новый    |
| 8      | Лаваш            | Lavash         | Хлеб и выпечка    | новый    |
| 9      | Пита             | Pita bread     | Хлеб и выпечка    | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Брынза» — a white block of feta; 2) «Творожный сыр» — a tub of cream cheese; 3) «Сгущённое молоко» — a tin of condensed milk
Row 2: 4) «Греческий йогурт» — greek yogurt; 5) «Овсяное молоко» — a carton of oat milk; 6) «Топлёное масло» — a glass jar of golden ghee
Row 3: 7) «Батон» — an oval Russian white loaf with diagonal cuts; 8) «Лаваш» — a folded thin flatbread; 9) «Пита» — pita bread
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Брынза» → "Feta cheese"; 2) «Творожный сыр» → "Cream cheese"; 3) «Сгущённое молоко» → "Condensed milk"; 4) «Греческий йогурт» → "Greek yogurt"; 5) «Овсяное молоко» → "Oat milk"; 6) «Топлёное масло» → "Ghee"; 7) «Батон» → "White loaf"; 8) «Лаваш» → "Lavash"; 9) «Пита» → "Pita bread"
```
