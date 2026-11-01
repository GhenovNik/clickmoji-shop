# batch-011

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-011.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-011-en.png`.

| Ячейка | Товар          | English      | Категория     | Действие |
| ------ | -------------- | ------------ | ------------- | -------- |
| 1      | Чёрный перец   | Black pepper | Масла и соусы | новый    |
| 2      | Корица         | Cinnamon     | Масла и соусы | новый    |
| 3      | Паприка        | Paprika      | Масла и соусы | новый    |
| 4      | Соус барбекю   | BBQ sauce    | Масла и соусы | новый    |
| 5      | Острый соус    | Hot sauce    | Масла и соусы | новый    |
| 6      | Песто          | Pesto        | Масла и соусы | новый    |
| 7      | Соус для пасты | Pasta sauce  | Масла и соусы | новый    |
| 8      | Сальса         | Salsa        | Масла и соусы | новый    |
| 9      | Тахини         | Tahini       | Масла и соусы | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Чёрный перец» — a pepper mill; 2) «Корица» — cinnamon; 3) «Паприка» — paprika
Row 2: 4) «Соус барбекю» — bbq sauce; 5) «Острый соус» — hot sauce; 6) «Песто» — pesto
Row 3: 7) «Соус для пасты» — a jar of red marinara sauce; 8) «Сальса» — salsa; 9) «Тахини» — tahini
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Чёрный перец» → "Black pepper"; 2) «Корица» → "Cinnamon"; 3) «Паприка» → "Paprika"; 4) «Соус барбекю» → "BBQ sauce"; 5) «Острый соус» → "Hot sauce"; 6) «Песто» → "Pesto"; 7) «Соус для пасты» → "Pasta sauce"; 8) «Сальса» → "Salsa"; 9) «Тахини» → "Tahini"
```
