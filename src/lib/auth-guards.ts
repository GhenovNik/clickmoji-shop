import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { apiText } from '@/lib/api-messages';
import { GUEST_ACTIVITY_TOUCH_INTERVAL_MS, isSessionTokenFreshForUser } from '@/lib/guest';

type GuardResult = { session: Session } | NextResponse;

export async function requireAdmin(): Promise<GuardResult> {
  const session = await auth();

  if (!session || session.user.role !== 'ADMIN' || session.user.isGuest) {
    return NextResponse.json({ error: await apiText(undefined, 'unauthorized') }, { status: 401 });
  }

  return { session };
}

export async function requireUser(): Promise<GuardResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: await apiText(undefined, 'unauthorized') }, { status: 401 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      role: true,
      isGuest: true,
      guestLastActiveAt: true,
      createdAt: true,
    },
  });

  if (!dbUser || !isSessionTokenFreshForUser(session.tokenIssuedAt, dbUser.createdAt)) {
    return NextResponse.json({ error: await apiText(undefined, 'unauthorized') }, { status: 401 });
  }

  if (dbUser.isGuest) {
    const now = new Date();
    const shouldTouch =
      !dbUser.guestLastActiveAt ||
      now.getTime() - dbUser.guestLastActiveAt.getTime() >= GUEST_ACTIVITY_TOUCH_INTERVAL_MS;
    if (shouldTouch && typeof prisma.user.updateMany === 'function') {
      await prisma.user
        .updateMany({
          where: { id: dbUser.id, isGuest: true },
          data: { guestLastActiveAt: now },
        })
        .catch(() => undefined);
    }
  }

  return {
    session: {
      ...session,
      user: {
        ...session.user,
        id: dbUser.id,
        role: dbUser.role,
        isGuest: dbUser.isGuest,
      },
    },
  };
}
