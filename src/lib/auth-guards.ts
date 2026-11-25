import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { apiText } from '@/lib/api-messages';
import { recordGuestActivity } from '@/lib/guest-activity';
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

  if (!dbUser || !isSessionTokenFreshForUser(session.sessionIssuedAt, dbUser.createdAt)) {
    return NextResponse.json({ error: await apiText(undefined, 'unauthorized') }, { status: 401 });
  }

  if (dbUser.isGuest) {
    const now = new Date();
    const shouldTouch =
      !dbUser.guestLastActiveAt ||
      now.getTime() - dbUser.guestLastActiveAt.getTime() >= GUEST_ACTIVITY_TOUCH_INTERVAL_MS;
    if (shouldTouch) {
      // The request is served only after the activity is persisted. A failed write is not
      // swallowed, and a guest row that is already gone (cleanup at the cutoff) is not revived.
      let recorded: boolean;
      try {
        recorded = await recordGuestActivity(dbUser.id, now);
      } catch (error) {
        console.error('Guest activity update failed:', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        return NextResponse.json(
          { error: await apiText(undefined, 'guestActivityFailed') },
          { status: 503 }
        );
      }
      if (!recorded) {
        return NextResponse.json(
          { error: await apiText(undefined, 'unauthorized') },
          { status: 401 }
        );
      }
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
