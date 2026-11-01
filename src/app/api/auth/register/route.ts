import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { createEmailVerificationToken } from '@/lib/auth-tokens';
import { isEmailVerificationRequired, sendVerificationEmail } from '@/lib/email';
import { getPasswordValidationError } from '@/lib/validation/password';
import {
  checkRateLimit,
  getClientIp,
  getRequestLocale,
  getServerTranslator,
  isValidEmail,
  normalizeEmail,
  rateLimitResponse,
} from '@/lib/auth-security';

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

    if (!isValidEmail(normalizedEmail)) {
      return NextResponse.json({ error: t('api.auth.invalidEmail') }, { status: 400 });
    }

    const passwordError = getPasswordValidationError(password, locale);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
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
        name: typeof name === 'string' ? name.trim() || null : null,
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
    const defaultLists = [
      { name: t('api.lists.defaultNames.main'), isActive: true },
      { name: t('api.lists.defaultNames.weekend'), isActive: false },
      { name: t('api.lists.defaultNames.holidays'), isActive: false },
      { name: t('api.lists.defaultNames.party'), isActive: false },
      { name: t('api.lists.defaultNames.urgent'), isActive: false },
    ];

    await prisma.list.createMany({
      data: defaultLists.map((list) => ({
        ...list,
        userId: user.id,
      })),
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
