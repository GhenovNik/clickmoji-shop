import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getRequestLocale } from '@/lib/auth-security';
import { searchProducts } from '@/lib/services/product-search';

export async function GET(request: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id || null;

    const query = new URL(request.url).searchParams.get('q');
    if (!query || query.trim().length === 0) {
      return NextResponse.json([]);
    }

    const products = await searchProducts({
      term: query,
      userId,
      locale: getRequestLocale(request),
    });
    return NextResponse.json(products);
  } catch (error) {
    console.error('Error searching products:', error);
    return NextResponse.json({ error: 'Failed to search products' }, { status: 500 });
  }
}
