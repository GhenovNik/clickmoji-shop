import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';

// POST /api/lists/init - создать базовые списки если их нет
export async function POST() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Проверяем есть ли уже списки
    const existingLists = await prisma.list.findMany({
      where: {
        userId: session.user.id,
      },
    });

    if (existingLists.length > 0) {
      return NextResponse.json({ message: 'Lists already exist' });
    }

    // Создаем базовые списки
    const defaultLists = [
      { name: 'На неделю', isActive: true },
      { name: 'Для вечеринки', isActive: false },
      { name: 'На выходные', isActive: false },
      { name: 'Чтобы выжить', isActive: false },
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
