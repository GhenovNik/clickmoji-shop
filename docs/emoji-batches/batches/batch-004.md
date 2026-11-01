# batch-004

Новый чат в Gemini → вставить промпт → сохранить картинку как `batch-004.png`. Если на картинке
есть надписи — в том же чате отправить английский промпт и сохранить ответ как `batch-004-en.png`.

| Ячейка | Товар     | English       | Категория | Действие |
| ------ | --------- | ------------- | --------- | -------- |
| 1      | Маракуйя  | Passion fruit | Фрукты    | новый    |
| 2      | Смородина | Currants      | Фрукты    | новый    |
| 3      | Крыжовник | Gooseberries  | Фрукты    | новый    |
| 4      | Клюква    | Cranberries   | Фрукты    | новый    |
| 5      | Брусника  | Lingonberries | Фрукты    | новый    |
| 6      | Облепиха  | Sea buckthorn | Фрукты    | новый    |
| 7      | Помело    | Pomelo        | Фрукты    | новый    |
| 8      | Айва      | Quince        | Фрукты    | новый    |
| 9      | Личи      | Lychee        | Фрукты    | новый    |

## Промпт

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: Apple iOS emoji style — exactly like the emoji set on an iPhone (match the attached samples if any). Soft volume, smooth rounded shapes, subtle gradients, gentle highlights. One consistent emoji set.
NOT photorealistic. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions or labels under the icons. Text only where it is printed on the product's own packaging, short and spelled correctly in Russian.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.

Cells, left to right, top to bottom:
Row 1: 1) «Маракуйя» — passion fruit; 2) «Смородина» — a cluster of blackcurrants; 3) «Крыжовник» — gooseberries
Row 2: 4) «Клюква» — cranberries; 5) «Брусника» — lingonberries; 6) «Облепиха» — a branch of orange sea buckthorn berries
Row 3: 7) «Помело» — pomelo; 8) «Айва» — quince; 9) «Личи» — lychee
```

## Английская версия (только если есть надписи, в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Change ONLY the text printed on the packaging, translating it into short correct English. Icons without text stay exactly as they are. Do not add any new text.
Cell names for reference: 1) «Маракуйя» → "Passion fruit"; 2) «Смородина» → "Currants"; 3) «Крыжовник» → "Gooseberries"; 4) «Клюква» → "Cranberries"; 5) «Брусника» → "Lingonberries"; 6) «Облепиха» → "Sea buckthorn"; 7) «Помело» → "Pomelo"; 8) «Айва» → "Quince"; 9) «Личи» → "Lychee"
```
