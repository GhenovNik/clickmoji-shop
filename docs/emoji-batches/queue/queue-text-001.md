# queue-text-001 — с надписями (две версии)

1. **Новый чат** в Gemini. Приложить все четыре образца из `docs/emoji-batches/style-refs/` (`zucchini.webp`, `lentils.webp`, `honey.webp`, `kefir.webp`). Вставить промпт «Русская версия» и сохранить как `queue-text-001.png`.
2. **В том же чате** → промпт «Английская версия» → сохранить как `queue-text-001-en.png`.
   Рисунки остаются те же, меняются только надписи.

| Ячейка | Цель            | English     | Каталог                | Тип   |
| ------ | --------------- | ----------- | ---------------------- | ----- |
| 1      | Масло сливочное | Butter      | Молочные продукты      | товар |
| 2      | Молоко          | Milk        | Молочные продукты      | товар |
| 3      | Мороженое       | Ice Cream   | Молочные продукты      | товар |
| 4      | Сыр             | Cheese      | Молочные продукты      | товар |
| 5      | Вафли           | Waffles     | Хлеб и выпечка         | товар |
| 6      | Печенье         | Cookies     | Хлеб и выпечка         | товар |
| 7      | Бекон           | Bacon       | Мясо и мясные продукты | товар |
| 8      | Консервы        | Canned Food | Консервы и готовая еда | товар |
| 9      | Лапша           | Noodles     | Консервы и готовая еда | товар |

## Русская версия

```text
Create ONE square image: a 3×3 grid of separate product emoji on a pure white background (#FFFFFF).

Style: One object viewed from the front at a slight angle, filling 70–80% of the cell; simplified smooth forms, 3–5 saturated colors, soft upper-left light and one soft highlight. No texture, pores, fibres, grains or photographic reflections; no outlines or background shadows. Labels are flat, single-color, with up to two large words. Recognizable at 32px.
Category cells: Compose two or three items of the same group with the same lighting and simplification.
NOT photorealistic, NOT a cartoon sticker: no thick dark outlines. NO shadows or drop shadows. NO grid lines, cell borders, frames or dividers. NO captions under the icons.
Every icon is centered in its own cell with generous white space around it; no icon touches or crosses its cell edge.
Each product is shown in its typical packaging with ONE short label in Russian, exactly the quoted word(s) below, large, spelled correctly. No other text, no brand names.

Cells, left to right, top to bottom (label in quotes):
Row 1: 1) label «Масло сливочное» — butter; 2) label «Молоко» — milk; 3) label «Мороженое» — ice cream
Row 2: 4) label «Сыр» — cheese; 5) label «Вафли» — waffles; 6) label «Печенье» — cookies
Row 3: 7) label «Бекон» — bacon; 8) label «Консервы» — canned food; 9) label «Лапша» — noodles
```

## Английская версия (в том же чате)

```text
Make exactly the same image: the same drawings, layout, colours and white background. Replace ONLY the label text with English, exactly as listed. Do not add any other text.
1) «Масло сливочное» → "Butter"; 2) «Молоко» → "Milk"; 3) «Мороженое» → "Ice Cream"; 4) «Сыр» → "Cheese"; 5) «Вафли» → "Waffles"; 6) «Печенье» → "Cookies"; 7) «Бекон» → "Bacon"; 8) «Консервы» → "Canned Food"; 9) «Лапша» → "Noodles"
```
