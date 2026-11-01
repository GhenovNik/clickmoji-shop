// A grid card leaves about 76px for the name on a phone: a word of ten letters (Bulgarian pepper in
// Russian) or a long name (dishwasher tablets) does not fit two lines of text-sm, so such names get
// a smaller size and a third line, and words break with a hyphen instead of being clipped.
const LONG_WORD = 9;
const LONG_NAME = 16;

export function productNameClassName(name: string) {
  const longestWord = Math.max(0, ...name.split(/\s+/).map((word) => word.length));
  const long = longestWord > LONG_WORD || name.length > LONG_NAME;
  const size = long ? 'text-xs line-clamp-3' : 'text-sm line-clamp-2';
  return `${size} hyphens-auto [overflow-wrap:anywhere] leading-[1.1] font-medium text-gray-900`;
}
