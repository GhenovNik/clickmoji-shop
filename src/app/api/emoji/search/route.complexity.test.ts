// @vitest-environment node
import { expect, it, vi } from 'vitest';

// The route merges the Russian and English emojibase datasets once at module load. This test
// counts how often the merge reads an English entry's hexcode on a synthetic dataset: a lookup
// per Russian entry by scanning the English array reads it ~n²/2 times, an index reads it n times.
const N = 400;

const counter = vi.hoisted(() => ({ englishHexcodeReads: 0 }));

vi.mock('emojibase-data/en/data.json', () => ({
  default: Array.from({ length: 400 }, (_, index) => {
    const hexcode = `E${index}`;
    return {
      emoji: `en-${index}`,
      label: `english label ${index}`,
      tags: [`tag${index}`],
      get hexcode() {
        counter.englishHexcodeReads += 1;
        return hexcode;
      },
    };
  }),
}));

vi.mock('emojibase-data/ru/data.json', () => ({
  // Reversed order, so a scan of the English array has to walk past most entries.
  default: Array.from({ length: 400 }, (_, position) => {
    const index = 400 - 1 - position;
    return {
      emoji: `ru-${index}`,
      label: index % 2 === 0 ? `метка ${index}` : '',
      hexcode: `E${index}`,
    };
  }),
}));

it('merges the datasets with one hexcode read per English entry', async () => {
  const { GET } = await import('./route');

  expect(counter.englishHexcodeReads).toBeLessThanOrEqual(2 * N);

  // The merge still takes the English label when the Russian one is empty.
  const response = await GET(new Request('http://localhost/api/emoji/search?q=english label 7'));
  const body = await response.json();
  expect(body.results.map((result: { emoji: string }) => result.emoji)).toContain('ru-7');
});
