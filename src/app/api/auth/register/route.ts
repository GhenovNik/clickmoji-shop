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
  convertGuestToRegisteredUser,
  findConvertibleGuestFromRequest,
  revertGuestConversion,
} from '@/lib/guest-conversion';
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

    if (!isValidEmail(normalizedEmail) || isGuestEmail(normalizedEmail)) {
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

    // A server guest converts in place: same User.id, lists, purchases and history are kept.
    const guest = await findConvertibleGuestFromRequest(request);
    if (guest) {
      const conversion = await convertGuestToRegisteredUser({
        guest,
        email: normalizedEmail,
        passwordHash: hashedPassword,
        name: typeof name === 'string' ? name.trim() || null : null,
        requiresEmailVerification,
      });

      if (conversion.kind === 'duplicate') {
        return NextResponse.json({ error: t('api.auth.userExists') }, { status: 400 });
      }

      if (conversion.kind === 'converted') {
        let emailSent = false;
        if (requiresEmailVerification) {
          try {
            const token = await createEmailVerificationToken(normalizedEmail);
            await sendVerificationEmail({ email: normalizedEmail, token, locale });
            emailSent = true;
          } catch (emailError) {
            console.error('Verification email error:', emailError);
            // Strict mode: the guest keeps its shopping data and returns to guest state.
            await revertGuestConversion(guest, normalizedEmail);
            return NextResponse.json(
              { error: t('api.auth.verificationEmailFailed') },
              { status: 503 }
            );
          }
        }

        return NextResponse.json(
          {
            message: t('api.auth.userCreated'),
            emailSent,
            requiresEmailVerification,
            converted: true,
            user: {
              id: conversion.user.id,
              email: conversion.user.email,
              name: conversion.user.name,
            },
          },
          { status: 201 }
        );
      }
      // The guest row vanished between the session check and the update: register normally below.
    }

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
