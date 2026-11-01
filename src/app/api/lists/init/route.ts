import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { getRequestLocale, getServerTranslator } from '@/lib/auth-security';

// POST /api/lists/init - create starter lists when the account has none, named in the
// language of the request.
export async function POST(request: Request) {
  const t = getServerTranslator(getRequestLocale(request));
  try {
    const guard = await requireUser();
    if (guard instanceof Response) return guard;
    const { session } = guard;

    // Do not duplicate lists for initialized accounts.
    const existingLists = await prisma.list.findMany({
      where: {
        userId: session.user.id,
      },
    });

    if (existingLists.length > 0) {
      return NextResponse.json({ message: 'Lists already exist' });
    }

    // Create the starter lists.
    const defaultLists = [
      { name: t('api.lists.defaultNames.week'), isActive: true },
      { name: t('api.lists.defaultNames.party'), isActive: false },
      { name: t('api.lists.defaultNames.weekend'), isActive: false },
      { name: t('api.lists.defaultNames.survival'), isActive: false },
    ];

    await prisma.list.createMany({
      data: defaultLists.map((list) => ({
        ...list,
        userId: session.user.id,
      })),
    });

    const lists = await prisma.list.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        _count: {
          select: {
            items: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return NextResponse.json(lists);
  } catch (error) {
    console.error('Error initializing lists:', error);
    return NextResponse.json({ error: 'Failed to initialize lists' }, { status: 500 });
  }
}
