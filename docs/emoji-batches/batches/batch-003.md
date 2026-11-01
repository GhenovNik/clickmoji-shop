# batch-003

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-003.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-003-en.png`.

| Ячейка | Товар       | English      | Категория | Действие |
| ------ | ----------- | ------------ | --------- | -------- |
| 1      | Ростки маша | Bean sprouts | Овощи     | новый    |
| 2      | Халапеньо   | Jalapeño     | Овощи     | новый    |
| 3      | Пастернак   | Parsnip      | Овощи     | новый    |
| 4      | Грейпфрут   | Grapefruit   | Фрукты    | новый    |
| 5      | Лайм        | Lime         | Фрукты    | новый    |
| 6      | Гранат      | Pomegranate  | Фрукты    | новый    |
| 7      | Кокос       | Coconut      | Фрукты    | новый    |
| 8      | Хурма       | Persimmon    | Фрукты    | новый    |
| 9      | Папайя      | Papaya       | Фрукты    | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Ростки маша» — bean sprouts; 2) «Халапеньо» — jalapeño; 3) «Пастернак» — parsnip
Row 2: 4) «Грейпфрут» — grapefruit; 5) «Лайм» — lime; 6) «Гранат» — pomegranate
Row 3: 7) «Кокос» — coconut; 8) «Хурма» — persimmon; 9) «Папайя» — papaya
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Ростки маша» → "Bean sprouts"; 2) «Халапеньо» → "Jalapeño"; 3) «Пастернак» → "Parsnip"; 4) «Грейпфрут» → "Grapefruit"; 5) «Лайм» → "Lime"; 6) «Гранат» → "Pomegranate"; 7) «Кокос» → "Coconut"; 8) «Хурма» → "Persimmon"; 9) «Папайя» → "Papaya"
```
