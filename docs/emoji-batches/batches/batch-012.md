# batch-012

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-012.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-012-en.png`.

| Ячейка | Товар           | English        | Категория     | Действие |
| ------ | --------------- | -------------- | ------------- | -------- |
| 1      | Кунжутное масло | Sesame oil     | Масла и соусы | новый    |
| 2      | Соус ранч       | Ranch dressing | Масла и соусы | новый    |
| 3      | Шоколад         | Chocolate bar  | Сладости      | новый    |
| 4      | Конфеты         | Candies        | Сладости      | новый    |
| 5      | Мармелад        | Gummy candy    | Сладости      | новый    |
| 6      | Зефир           | Zefir          | Сладости      | новый    |
| 7      | Пряники         | Pryaniki       | Сладости      | новый    |
| 8      | Халва           | Halva          | Сладости      | новый    |
| 9      | Леденец         | Lollipop       | Сладости      | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Кунжутное масло» — sesame oil; 2) «Соус ранч» — ranch dressing; 3) «Шоколад» — chocolate bar
Row 2: 4) «Конфеты» — wrapped bonbons; 5) «Мармелад» — gummy candy; 6) «Зефир» — two pastel zefir marshmallows
Row 3: 7) «Пряники» — glazed round gingerbread cookies; 8) «Халва» — halva; 9) «Леденец» — lollipop
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Кунжутное масло» → "Sesame oil"; 2) «Соус ранч» → "Ranch dressing"; 3) «Шоколад» → "Chocolate bar"; 4) «Конфеты» → "Candies"; 5) «Мармелад» → "Gummy candy"; 6) «Зефир» → "Zefir"; 7) «Пряники» → "Pryaniki"; 8) «Халва» → "Halva"; 9) «Леденец» → "Lollipop"
```
