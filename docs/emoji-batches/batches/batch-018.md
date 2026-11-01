# batch-018

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-018.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-018-en.png`.

| Ячейка | Товар              | English           | Категория       | Действие |
| ------ | ------------------ | ----------------- | --------------- | -------- |
| 1      | Влажные салфетки   | Wet wipes         | Товары для дома | новый    |
| 2      | Одноразовая посуда | Disposable plates | Товары для дома | новый    |
| 3      | Капли для носа     | Nasal spray       | Аптека          | новый    |
| 4      | Сироп от кашля     | Cough syrup       | Аптека          | новый    |
| 5      | Бинт               | Gauze roll        | Аптека          | новый    |
| 6      | Антисептик         | Hand sanitizer    | Аптека          | новый    |
| 7      | Медицинские маски  | Face masks        | Аптека          | новый    |
| 8      | Глазные капли      | Eye drops         | Аптека          | новый    |
| 9      | Зубная нить        | Dental floss      | Аптека          | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Влажные салфетки» — wet wipes; 2) «Одноразовая посуда» — disposable plates; 3) «Капли для носа» — nasal spray
Row 2: 4) «Сироп от кашля» — cough syrup; 5) «Бинт» — gauze roll; 6) «Антисептик» — hand sanitizer
Row 3: 7) «Медицинские маски» — face masks; 8) «Глазные капли» — eye drops; 9) «Зубная нить» — dental floss
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Влажные салфетки» → "Wet wipes"; 2) «Одноразовая посуда» → "Disposable plates"; 3) «Капли для носа» → "Nasal spray"; 4) «Сироп от кашля» → "Cough syrup"; 5) «Бинт» → "Gauze roll"; 6) «Антисептик» → "Hand sanitizer"; 7) «Медицинские маски» → "Face masks"; 8) «Глазные капли» → "Eye drops"; 9) «Зубная нить» → "Dental floss"
```
