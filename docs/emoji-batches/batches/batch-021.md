# batch-021

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-021.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-021-en.png`.

| Ячейка | Товар             | English           | Категория          | Действие |
| ------ | ----------------- | ----------------- | ------------------ | -------- |
| 1      | Фундук            | Hazelnuts         | Орехи и Сухофрукты | новый    |
| 2      | Фисташки          | Pistachios        | Орехи и Сухофрукты | новый    |
| 3      | Кедровые орехи    | Pine nuts         | Орехи и Сухофрукты | новый    |
| 4      | Семечки           | Sunflower seeds   | Орехи и Сухофрукты | новый    |
| 5      | Тыквенные семечки | Pumpkin seeds     | Орехи и Сухофрукты | новый    |
| 6      | Кунжут            | Sesame seeds      | Орехи и Сухофрукты | новый    |
| 7      | Пекан             | Pecans            | Орехи и Сухофрукты | новый    |
| 8      | Сушёная клюква    | Dried cranberries | Орехи и Сухофрукты | новый    |
| 9      | Кокосовая стружка | Coconut flakes    | Орехи и Сухофрукты | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Фундук» — hazelnuts; 2) «Фисташки» — pistachios; 3) «Кедровые орехи» — pine nuts
Row 2: 4) «Семечки» — sunflower seeds; 5) «Тыквенные семечки» — pumpkin seeds; 6) «Кунжут» — sesame seeds
Row 3: 7) «Пекан» — pecans; 8) «Сушёная клюква» — dried cranberries; 9) «Кокосовая стружка» — coconut flakes
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Фундук» → "Hazelnuts"; 2) «Фисташки» → "Pistachios"; 3) «Кедровые орехи» → "Pine nuts"; 4) «Семечки» → "Sunflower seeds"; 5) «Тыквенные семечки» → "Pumpkin seeds"; 6) «Кунжут» → "Sesame seeds"; 7) «Пекан» → "Pecans"; 8) «Сушёная клюква» → "Dried cranberries"; 9) «Кокосовая стружка» → "Coconut flakes"
```
