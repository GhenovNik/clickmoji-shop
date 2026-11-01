import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/auth-guards';
import { getRequestLocale } from '@/lib/auth-security';
import { localizedName } from '@/lib/catalog-name';

export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const body = await request.json();
    const { productIds, newCategoryId } = body;

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return NextResponse.json(
        { error: await apiText(request, 'productIdsRequired') },
        { status: 400 }
      );
    }

    if (!newCategoryId) {
      return NextResponse.json(
        { error: await apiText(request, 'newCategoryIdRequired') },
        { status: 400 }
      );
    }

    // Reject moves to categories that no longer exist.
    const targetCategory = await prisma.category.findUnique({
      where: { id: newCategoryId },
    });

    if (!targetCategory) {
      return NextResponse.json(
        { error: await apiText(request, 'targetCategoryNotFound') },
        { status: 404 }
      );
    }

    // Move all selected products in one database operation.
    const result = await prisma.product.updateMany({
      where: {
        id: {
          in: productIds,
        },
      },
      data: {
        categoryId: newCategoryId,
      },
    });

    return NextResponse.json({
      success: true,
      movedCount: result.count,
      // The category name is read in the interface language, like the bulk-import report.
      targetCategory: localizedName(targetCategory, getRequestLocale(request)),
    });
  } catch (error) {
    console.error('Error moving products to new category:', error);
    return NextResponse.json(
      { error: await apiText(request, 'moveProductsFailed') },
      { status: 500 }
    );
  }
}
