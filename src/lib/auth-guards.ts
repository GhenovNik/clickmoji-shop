import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

type GuardResult = { session: Session } | NextResponse;

export async function requireAdmin(): Promise<GuardResult> {
  const session = await auth();

  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return { session };
}

export async function requireUser(): Promise<GuardResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
  });

  if (!dbUser && session.user.email) {
    const userByEmail = await prisma.user.findUnique({
      where: { email: session.user.email },
    });

    if (!userByEmail) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return {
      session: {
        ...session,
        user: {
          ...session.user,
          id: userByEmail.id,
          role: userByEmail.role,
        },
      },
    };
  }

  if (!dbUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return {
    session: {
      ...session,
      user: {
        ...session.user,
        role: dbUser.role,
      },
    },
  };
}
