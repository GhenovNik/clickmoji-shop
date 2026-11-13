import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth-guards';
import { getRequestLocale, getServerTranslator } from '@/lib/auth-security';
import { starterListData } from '@/lib/starter-lists';

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
      return NextResponse.json({ message: await apiText(request, 'listsAlreadyExist') });
    }

    // Create the starter lists.
    await prisma.list.createMany({
      data: starterListData(t, session.user.id),
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
    return NextResponse.json({ error: await apiText(request, 'initListsFailed') }, { status: 500 });
  }
}
