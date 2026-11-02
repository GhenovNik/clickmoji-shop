import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { auth } from '@/lib/auth';
import { getRequestLocale } from '@/lib/auth-security';
import { isLocale } from '@/i18n/config';
import { searchProducts } from '@/lib/services/product-search';

export async function GET(request: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id || null;

    const params = new URL(request.url).searchParams;
    const query = params.get('q');
    // The client names the language it caches the answer under; the cookie is the fallback.
    const requested = params.get('locale');
    const locale = isLocale(requested) ? requested : getRequestLocale(request);
    if (!query || query.trim().length === 0) {
      return NextResponse.json([]);
    }

    const products = await searchProducts({
      term: query,
      userId,
      locale,
    });
    return NextResponse.json(products);
  } catch (error) {
    console.error('Error searching products:', error);
    return NextResponse.json(
      { error: await apiText(request, 'searchProductsFailed') },
      { status: 500 }
    );
  }
}
