import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { searchEmojiLibrary } from '@/lib/services/emoji-library';

export async function GET(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const query = new URL(request.url).searchParams.get('q') ?? '';
    const items = await searchEmojiLibrary(query.slice(0, 100));

    return NextResponse.json({ items });
  } catch (error) {
    console.error('Error searching emoji library:', error);
    return NextResponse.json({ error: 'Failed to search emoji library' }, { status: 500 });
  }
}
