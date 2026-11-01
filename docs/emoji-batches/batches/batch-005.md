# batch-005

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-005.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-005-en.png`.

| Ячейка | Товар               | English           | Категория         | Действие |
| ------ | ------------------- | ----------------- | ----------------- | -------- |
| 1      | Питахайя            | Dragon fruit      | Фрукты            | новый    |
| 2      | Фейхоа              | Feijoa            | Фрукты            | новый    |
| 3      | Кефир               | Kefir             | Молочные продукты | новый    |
| 4      | Ряженка             | Ryazhenka         | Молочные продукты | новый    |
| 5      | Сливки              | Heavy cream       | Молочные продукты | новый    |
| 6      | Моцарелла           | Mozzarella        | Молочные продукты | новый    |
| 7      | Пармезан            | Parmesan          | Молочные продукты | новый    |
| 8      | Плавленый сыр       | Processed cheese  | Молочные продукты | новый    |
| 9      | Глазированный сырок | Glazed curd snack | Молочные продукты | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Питахайя» — dragon fruit; 2) «Фейхоа» — feijoa; 3) «Кефир» — a white carton of kefir
Row 2: 4) «Ряженка» — a glass bottle of creamy beige baked milk; 5) «Сливки» — a small carton of cream; 6) «Моцарелла» — white mozzarella balls
Row 3: 7) «Пармезан» — a wedge of hard parmesan; 8) «Плавленый сыр» — a round box of cheese wedges; 9) «Глазированный сырок» — a small chocolate-glazed curd bar
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Питахайя» → "Dragon fruit"; 2) «Фейхоа» → "Feijoa"; 3) «Кефир» → "Kefir"; 4) «Ряженка» → "Ryazhenka"; 5) «Сливки» → "Heavy cream"; 6) «Моцарелла» → "Mozzarella"; 7) «Пармезан» → "Parmesan"; 8) «Плавленый сыр» → "Processed cheese"; 9) «Глазированный сырок» → "Glazed curd snack"
```
