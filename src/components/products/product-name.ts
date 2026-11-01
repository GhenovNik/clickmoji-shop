// A grid card is about 80px wide on a phone: a long word (Brussels sprouts in Russian) or a long
// name (dishwasher tablets) does not fit two lines of text-sm, so such names get a smaller size
// and a third line, and words break with a hyphen instead of being clipped.
const LONG_WORD = 10;
const LONG_NAME = 16;

export function productNameClassName(name: string) {
  const longestWord = Math.max(0, ...name.split(/\s+/).map((word) => word.length));
  const long = longestWord > LONG_WORD || name.length > LONG_NAME;
  const size = long ? 'text-xs line-clamp-3' : 'text-sm line-clamp-2';
  return `${size} hyphens-auto [overflow-wrap:anywhere] leading-[1.1] font-medium text-gray-900`;
}
