import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');

    if (!query || query.trim().length === 0) {
      return NextResponse.json([]);
    }

    const searchTerm = query.toLowerCase().trim();

    // Use PostgreSQL similarity search with pg_trgm for fuzzy matching
    const products = await prisma.$queryRaw<any[]>`
      SELECT
        p.id,
        p.name,
        p."nameEn",
        p.emoji,
        p."isCustom",
        p."imageUrl",
        json_build_object(
          'id', c.id,
          'name', c.name,
          'emoji', c.emoji
        ) as category,
        GREATEST(
          similarity(p.name, ${searchTerm}),
          similarity(p."nameEn", ${searchTerm})
        ) as sim_score,
        CASE
          WHEN LOWER(p.name) LIKE ${searchTerm + '%'} THEN 3
          WHEN LOWER(p."nameEn") LIKE ${searchTerm + '%'} THEN 3
          WHEN LOWER(p.name) LIKE ${'%' + searchTerm + '%'} THEN 2
          WHEN LOWER(p."nameEn") LIKE ${'%' + searchTerm + '%'} THEN 2
          ELSE 1
        END as match_priority
      FROM products p
      INNER JOIN categories c ON p."categoryId" = c.id
      WHERE
        p.name ILIKE ${'%' + searchTerm + '%'}
        OR p."nameEn" ILIKE ${'%' + searchTerm + '%'}
        OR similarity(p.name, ${searchTerm}) > 0.3
        OR similarity(p."nameEn", ${searchTerm}) > 0.3
      ORDER BY match_priority DESC, sim_score DESC, p.name ASC
      LIMIT 10
    `;

    return NextResponse.json(products);
  } catch (error) {
    console.error('Error searching products:', error);
    return NextResponse.json(
      { error: 'Failed to search products' },
      { status: 500 }
    );
  }
}
