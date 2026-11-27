import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { createEmailVerificationToken } from '@/lib/auth-tokens';
import { isEmailVerificationRequired, sendVerificationEmail } from '@/lib/email';
import { getPasswordValidationError } from '@/lib/validation/password';
import { starterListData } from '@/lib/starter-lists';
import { getGuestIdFromRequest, recordFunnelEvent } from '@/lib/funnel';
import { isGuestEmail } from '@/lib/guest';
import {
  clearSessionCookie,
  encodeOrdinarySession,
  promoteGuestAccount,
  protectGuestForRegistration,
  resolveRegistrationGuest,
  sessionCookieFor,
  VerificationDeliveryError,
} from '@/lib/guest-promotion';
import {
  checkRateLimit,
  getClientIp,
  getRequestLocale,
  getServerTranslator,
  isValidEmail,
  normalizeEmail,
  rateLimitResponse,
} from '@/lib/auth-security';

type Translator = ReturnType<typeof getServerTranslator>;

export async function POST(request: Request) {
  const locale = getRequestLocale(request);
  const t = getServerTranslator(locale);
  try {
    const { email, password, name } = await request.json();
    const normalizedEmail = normalizeEmail(email || '');
    const ip = getClientIp(request);

    const ipLimit = await checkRateLimit({
      key: `auth:register:ip:${ip}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.resetAt, locale);
    }

    const emailLimit = await checkRateLimit({
      key: `auth:register:email:${normalizedEmail || 'missing'}`,
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!emailLimit.allowed) {
      return rateLimitResponse(emailLimit.resetAt, locale);
    }

    if (!normalizedEmail || !password) {
      return NextResponse.json({ error: t('api.auth.emailAndPasswordRequired') }, { status: 400 });
    }

    if (!isValidEmail(normalizedEmail) || isGuestEmail(normalizedEmail)) {
      return NextResponse.json({ error: t('api.auth.invalidEmail') }, { status: 400 });
    }

    const passwordError = getPasswordValidationError(password, locale);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const trimmedName = typeof name === 'string' ? name.trim() || null : null;

    // A guest session on this request promotes that guest in place (same User.id). A guest token
    // whose row is already an account is refused, so one browser never opens a second account.
    const guest = await resolveRegistrationGuest(request);
    if (guest.kind === 'promoted') {
      return NextResponse.json({ error: t('api.auth.userExists') }, { status: 400 });
    }
    if (guest.kind === 'stale') {
      // A signed guest token whose row is gone or no longer matches it. Creating an account here
      // would be a second user for the same browser, so the request fails and the stale cookie
      // is cleared; the next attempt starts from a clean session.
      const response = NextResponse.json(
        { error: t('api.auth.guestSessionExpired') },
        { status: 401 }
      );
      clearSessionCookie(response, request);
      return response;
    }
    if (guest.kind === 'guest') {
      return promoteGuestRegistration({
        request,
        locale,
        t,
        userId: guest.userId,
        guestId: guest.guestId,
        email: normalizedEmail,
        password,
        name: trimmedName,
      });
    }

    // Reject duplicate accounts before hashing the password.
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      return NextResponse.json({ error: t('api.auth.userExists') }, { status: 400 });
    }

    // Hash the password before persistence.
    const hashedPassword = await bcrypt.hash(password, 12);

    const requiresEmailVerification = isEmailVerificationRequired();

    // Create the user account.
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        name: trimmedName,
        emailVerified: requiresEmailVerification ? null : new Date(),
      },
    });

    let emailSent = false;
    if (requiresEmailVerification) {
      try {
        const token = await createEmailVerificationToken(normalizedEmail);
        await sendVerificationEmail({ email: normalizedEmail, token, locale });
        emailSent = true;
      } catch (emailError) {
        console.error('Verification email error:', emailError);

        // Strict mode: do not keep half-registered accounts if confirmation email was not sent.
        // Only this request's freshly created row is removed; a promoted guest never reaches here.
        await prisma.emailVerificationToken.deleteMany({
          where: { email: normalizedEmail },
        });
        await prisma.user.delete({
          where: { id: user.id },
        });

        return NextResponse.json({ error: t('api.auth.verificationEmailFailed') }, { status: 503 });
      }
    }

    // Create starter shopping lists for the new account.
    await prisma.list.createMany({
      data: starterListData(t, user.id),
    });

    const guestId = getGuestIdFromRequest(request);
    await recordFunnelEvent({
      type: 'REGISTER',
      userId: user.id,
      guestId,
      correlateGuest: true,
    });
    await recordFunnelEvent({
      type: 'LIST_CREATE',
      userId: user.id,
      guestId,
    });

    return NextResponse.json(
      {
        message: t('api.auth.userCreated'),
        emailSent,
        requiresEmailVerification,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json({ error: t('api.auth.registrationFailed') }, { status: 500 });
  }
}

type PromoteArgs = {
  request: Request;
  locale: ReturnType<typeof getRequestLocale>;
  t: Translator;
  userId: string;
  guestId: string | null;
  email: string;
  password: string;
  name: string | null;
};

/**
 * Promotes a live guest in place (AGE-1667). Nothing is created: the guest row keeps its id, lists
 * and history. Order: protect the guest from cleanup, check the email, hash, then promote in one
 * transaction. With verification required, the verification token is created and its email sent
 * inside that same transaction, before commit. Any failure rolls back the promotion and the token, so
 * the guest stays a guest and no unsuccessful request leaves a usable verification proof behind.
 *
 * With verification required, no session is issued: the guest cookie is cleared and the user signs in
 * after confirming the email. Without it, the ordinary session replaces the guest cookie at once.
 */
async function promoteGuestRegistration({
  request,
  locale,
  t,
  userId,
  guestId,
  email,
  password,
  name,
}: PromoteArgs) {
  if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
    throw new Error('Auth secret is missing');
  }

  // Cleanup protection: the guest is marked active before anything slow runs. Cleanup re-checks the
  // activity time in its own delete, so it cannot remove this guest while the registration runs.
  const active = await protectGuestForRegistration(userId);
  if (!active) {
    const response = NextResponse.json(
      { error: t('api.auth.guestSessionExpired') },
      { status: 401 }
    );
    clearSessionCookie(response, request);
    return response;
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json({ error: t('api.auth.userExists') }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const requiresEmailVerification = isEmailVerificationRequired();

  const outcome = await promoteGuestAccount({
    userId,
    guestId,
    email,
    passwordHash,
    name,
    emailVerified: requiresEmailVerification ? null : new Date(),
    beforeCommit: requiresEmailVerification
      ? async (tx) => {
          try {
            const token = await createEmailVerificationToken(email, tx);
            await sendVerificationEmail({ email, token, locale });
          } catch (emailError) {
            console.error('Verification email error:', emailError);
            throw new VerificationDeliveryError();
          }
        }
      : undefined,
  });

  if (outcome.status === 'expired') {
    const response = NextResponse.json(
      { error: t('api.auth.guestSessionExpired') },
      { status: 401 }
    );
    clearSessionCookie(response, request);
    return response;
  }
  if (outcome.status === 'already-registered' || outcome.status === 'email-taken') {
    return NextResponse.json({ error: t('api.auth.userExists') }, { status: 400 });
  }
  if (outcome.status === 'delivery-failed') {
    // Rolled back: the guest row, its lists and the token table are unchanged.
    return NextResponse.json({ error: t('api.auth.verificationEmailFailed') }, { status: 503 });
  }

  if (requiresEmailVerification) {
    // No session until the email is confirmed; the guest cookie is cleared so it cannot be reused.
    const response = NextResponse.json(
      {
        message: t('api.auth.userCreated'),
        emailSent: true,
        requiresEmailVerification: true,
        promoted: true,
        user: { id: outcome.user.id, email: outcome.user.email, name: outcome.user.name },
      },
      { status: 201 }
    );
    clearSessionCookie(response, request);
    return response;
  }

  // The guest session is replaced by an ordinary one. Old guest tokens for this id are rejected by
  // the jwt callback from now on, because the row is no longer a guest.
  const sessionJwt = await encodeOrdinarySession(outcome.user);
  const cookie = sessionCookieFor(request);

  const response = NextResponse.json(
    {
      message: t('api.auth.userCreated'),
      emailSent: false,
      requiresEmailVerification: false,
      promoted: true,
      user: {
        id: outcome.user.id,
        email: outcome.user.email,
        name: outcome.user.name,
      },
    },
    { status: 201 }
  );
  response.cookies.set(cookie.name, sessionJwt, cookie.options);
  return response;
}
