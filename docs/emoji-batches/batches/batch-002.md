# batch-002

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-002.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-002-en.png`.

| Ячейка | Товар                  | English         | Категория | Действие |
| ------ | ---------------------- | --------------- | --------- | -------- |
| 1      | Розмарин               | Rosemary        | Овощи     | новый    |
| 2      | Артишок                | Artichoke       | Овощи     | новый    |
| 3      | Стручковая фасоль      | Green beans     | Овощи     | новый    |
| 4      | Пекинская капуста      | Napa cabbage    | Овощи     | новый    |
| 5      | Краснокочанная капуста | Red cabbage     | Овощи     | новый    |
| 6      | Дайкон                 | Daikon radish   | Овощи     | новый    |
| 7      | Окра                   | Okra            | Овощи     | новый    |
| 8      | Хрен                   | Horseradish     | Овощи     | новый    |
| 9      | Помидоры черри         | Cherry tomatoes | Овощи     | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Розмарин» — two sprigs of rosemary; 2) «Артишок» — artichoke; 3) «Стручковая фасоль» — green beans
Row 2: 4) «Пекинская капуста» — napa cabbage; 5) «Краснокочанная капуста» — red cabbage; 6) «Дайкон» — a long white daikon radish
Row 3: 7) «Окра» — okra; 8) «Хрен» — a horseradish root; 9) «Помидоры черри» — a sprig of cherry tomatoes
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Розмарин» → "Rosemary"; 2) «Артишок» → "Artichoke"; 3) «Стручковая фасоль» → "Green beans"; 4) «Пекинская капуста» → "Napa cabbage"; 5) «Краснокочанная капуста» → "Red cabbage"; 6) «Дайкон» → "Daikon radish"; 7) «Окра» → "Okra"; 8) «Хрен» → "Horseradish"; 9) «Помидоры черри» → "Cherry tomatoes"
```
