import { NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { apiText } from '@/lib/api-messages';
import {
  checkRateLimit,
  getClientIp,
  getRequestLocale,
  getServerTranslator,
  rateLimitResponse,
} from '@/lib/auth-security';
import { getGuestIdFromRequest, recordFunnelEvent } from '@/lib/funnel';
import {
  buildGuestPlaceholderEmail,
  GUEST_SESSION_MAX_AGE_SECONDS,
  isSessionTokenFreshForUser,
  NEXTAUTH_SECURE_SESSION_COOKIE,
  NEXTAUTH_SESSION_COOKIE,
  shouldUseSecureSessionCookies,
} from '@/lib/guest';
import { starterListData } from '@/lib/starter-lists';

/**
 * POST /api/auth/guest - ensures a real User-backed NextAuth session for anonymous shoppers.
 * Reuses an active existing session (guest or regular) without minting churned accounts, creates
 * starter lists, and links the funnel REGISTER + LIST_CREATE milestones to the existing VISIT ID.
 */
export async function POST(request: Request) {
  const locale = getRequestLocale(request);
  const t = getServerTranslator(locale);

  try {
    const existingSession = await auth();
    if (existingSession?.user?.id) {
      const existingUser = await prisma.user.findUnique({
        where: { id: existingSession.user.id },
        select: { id: true, role: true, isGuest: true, createdAt: true },
      });
      if (
        existingUser &&
        isSessionTokenFreshForUser(existingSession.tokenIssuedAt, existingUser.createdAt)
      ) {
        if (existingUser.isGuest) {
          await prisma.user
            .updateMany({
              where: { id: existingUser.id, isGuest: true },
              data: { guestLastActiveAt: new Date() },
            })
            .catch(() => undefined);
        }
        return NextResponse.json({
          user: {
            id: existingUser.id,
            role: existingUser.role,
            isGuest: existingUser.isGuest,
          },
          reused: true,
        });
      }
    }

    const ip = getClientIp(request);
    const ipLimit = await checkRateLimit({
      key: `auth:guest:ip:${ip}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.resetAt, locale);
    }

    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
    if (!secret) {
      console.error('Guest session creation failed: auth secret is missing');
      return NextResponse.json(
        { error: await apiText(request, 'guestSessionFailed') },
        { status: 500 }
      );
    }

    // Use the Node clock for createdAt so NextAuth JWT `iat` (encoded immediately after) is
    // guaranteed to be >= Math.floor(createdAt.getTime() / 1000) without DB-vs-app clock skew.
    const now = new Date();
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: buildGuestPlaceholderEmail(),
          name: null,
          password: null,
          role: 'USER',
          emailVerified: null,
          isGuest: true,
          createdAt: now,
          guestLastActiveAt: now,
        },
        select: {
          id: true,
          email: true,
          name: true,
          image: true,
          role: true,
          isGuest: true,
        },
      });

      await tx.list.createMany({
        data: starterListData(t, created.id),
      });

      return created;
    });

    const guestId = getGuestIdFromRequest(request);
    // One REGISTER and one LIST_CREATE per funnel guestId: recreating a guest from the same browser
    // (cookie kept, session lost) must not inflate the funnel. The new User.id is still correlated.
    await recordFunnelEvent({
      type: 'REGISTER',
      userId: user.id,
      guestId,
      correlateGuest: true,
      dedupeByGuest: true,
    });
    await recordFunnelEvent({
      type: 'LIST_CREATE',
      userId: user.id,
      guestId,
      dedupeByGuest: true,
    });

    const sessionJwt = await encode({
      token: {
        id: user.id,
        role: user.role,
        email: user.email,
        isGuest: true,
        name: user.name,
        picture: user.image,
        sub: user.id,
      },
      secret,
      maxAge: GUEST_SESSION_MAX_AGE_SECONDS,
    });

    const useSecureCookies = shouldUseSecureSessionCookies(request);
    const cookieName = useSecureCookies ? NEXTAUTH_SECURE_SESSION_COOKIE : NEXTAUTH_SESSION_COOKIE;

    const response = NextResponse.json(
      {
        user: {
          id: user.id,
          role: user.role,
          isGuest: true,
        },
      },
      { status: 201 }
    );

    response.cookies.set(cookieName, sessionJwt, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: useSecureCookies,
      maxAge: GUEST_SESSION_MAX_AGE_SECONDS,
    });

    return response;
  } catch (error) {
    console.error('Guest session creation error:', error);
    return NextResponse.json(
      { error: await apiText(request, 'guestSessionFailed') },
      { status: 500 }
    );
  }
}
