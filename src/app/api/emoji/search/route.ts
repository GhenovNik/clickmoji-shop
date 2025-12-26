import { NextResponse } from 'next/server';
import Fuse from 'fuse.js';
import enData from 'emojibase-data/en/data.json';
import ruData from 'emojibase-data/ru/data.json';

type EmojiEntry = {
  emoji: string;
  label: string;
  group?: number;
  tags: string[];
  shortcodes: string[];
  hexcode: string;
};

// Build combined RU/EN dataset once per module load
const dataset: EmojiEntry[] = (ruData as EmojiEntry[])
  .map((ruItem) => {
    const enItem =
      (enData as EmojiEntry[]).find((i) => i.hexcode === ruItem.hexcode) ||
      ({} as Partial<EmojiEntry>);
    return {
      emoji: ruItem.emoji,
      label: ruItem.label || enItem.label || '',
      group: ruItem.group ?? enItem.group,
      tags: ruItem.tags || enItem.tags || [],
      shortcodes: ruItem.shortcodes || enItem.shortcodes || [],
      hexcode: ruItem.hexcode,
    };
  })
  .filter((item) => !!item.emoji && !!item.label);

const fuse = new Fuse(dataset, {
  keys: [
    { name: 'label', weight: 0.6 },
    { name: 'tags', weight: 0.25 },
    { name: 'shortcodes', weight: 0.15 },
  ],
  threshold: 0.35,
  ignoreLocation: true,
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.trim();

    if (!query) {
      return NextResponse.json({ error: 'Query parameter required' }, { status: 400 });
    }

    const results = fuse.search(query.toLowerCase(), { limit: 5 }).map(({ item }) => ({
      emoji: item.emoji,
      label: item.label,
      group: item.group,
      shortcodes: item.shortcodes,
      // twemojiUrl could be added here if needed using item.hexcode
    }));

    return NextResponse.json({
      query,
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('Error searching emoji:', error);
    return NextResponse.json({ error: 'Failed to search emoji' }, { status: 500 });
  }
}
