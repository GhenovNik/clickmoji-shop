import { decode } from 'next-auth/jwt';
import { prisma } from '@/lib/prisma';
import {
  isSessionTokenFreshForUser,
  NEXTAUTH_SECURE_SESSION_COOKIE,
  NEXTAUTH_SESSION_COOKIE,
  shouldUseSecureSessionCookies,
} from '@/lib/guest';

export type ConvertibleGuest = {
  id: string;
  /** The synthetic guest placeholder email, kept so a failed conversion can be reverted. */
  email: string;
};

export type GuestConversionResult =
  | { kind: 'converted'; user: { id: string; email: string; name: string | null } }
  | { kind: 'duplicate' }
  | { kind: 'missing' };

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

/**
 * Resolves the active server guest behind a request's NextAuth session cookie. Returns null for
 * regular users, missing or forged cookies, deleted rows, and tokens issued before the row was
 * created (a recreated guest cannot be revived by an older cookie).
 */
export async function findConvertibleGuestFromRequest(
  request: Request
): Promise<ConvertibleGuest | null> {
  const cookieHeader = request.headers.get('cookie');
  const cookieName = shouldUseSecureSessionCookies(request)
    ? NEXTAUTH_SECURE_SESSION_COOKIE
    : NEXTAUTH_SESSION_COOKIE;
  const rawToken = readCookie(cookieHeader, cookieName);
  if (!rawToken) return null;

  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) return null;

  let token: Awaited<ReturnType<typeof decode>>;
  try {
    token = await decode({ token: rawToken, secret });
  } catch {
    return null;
  }
  if (!token || token.isGuest !== true || typeof token.id !== 'string' || !token.id) {
    return null;
  }

  const row = await prisma.user.findUnique({
    where: { id: token.id },
    select: { id: true, email: true, isGuest: true, createdAt: true },
  });
  if (!row || !row.isGuest) return null;
  if (!isSessionTokenFreshForUser(token.iat as number | undefined, row.createdAt)) return null;

  return { id: row.id, email: row.email };
}

/**
 * Converts the guest row in place: the same User.id keeps its lists, purchases, history, AI
 * counters and funnel correlation, and only the real email, password and name are attached.
 * `isGuest` is conditional so a concurrent cleanup or conversion cannot be applied twice.
 */
export async function convertGuestToRegisteredUser({
  guest,
  email,
  passwordHash,
  name,
  requiresEmailVerification,
}: {
  guest: ConvertibleGuest;
  email: string;
  passwordHash: string;
  name: string | null;
  requiresEmailVerification: boolean;
}): Promise<GuestConversionResult> {
  try {
    const updated = await prisma.user.updateMany({
      where: { id: guest.id, isGuest: true },
      data: {
        email,
        password: passwordHash,
        name,
        emailVerified: requiresEmailVerification ? null : new Date(),
        isGuest: false,
        guestLastActiveAt: null,
      },
    });
    if (updated.count === 0) {
      return { kind: 'missing' };
    }
    const user = await prisma.user.findUnique({
      where: { id: guest.id },
      select: { id: true, email: true, name: true },
    });
    if (!user) {
      return { kind: 'missing' };
    }
    return { kind: 'converted', user };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2002'
    ) {
      return { kind: 'duplicate' };
    }
    throw error;
  }
}

/** Undoes a conversion whose verification email could not be sent, restoring the guest row. */
export async function revertGuestConversion(guest: ConvertibleGuest, email: string) {
  await prisma.emailVerificationToken.deleteMany({ where: { email } });
  await prisma.user.updateMany({
    where: { id: guest.id, isGuest: false },
    data: {
      email: guest.email,
      password: null,
      name: null,
      emailVerified: null,
      isGuest: true,
      guestLastActiveAt: new Date(),
    },
  });
}
