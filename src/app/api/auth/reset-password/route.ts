import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { consumePasswordResetToken } from '@/lib/auth-tokens';
import { getPasswordValidationError } from '@/lib/validation/password';
import { isGuestEmail } from '@/lib/guest';
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
    const { email, token, password } = await request.json();
    const normalizedEmail = normalizeEmail(email || '');
    const ip = getClientIp(request);

    const ipLimit = await checkRateLimit({
      key: `auth:reset:ip:${ip}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.resetAt, locale);
    }

    if (!normalizedEmail || !token || !password) {
      return NextResponse.json({ error: t('api.auth.resetFieldsRequired') }, { status: 400 });
    }

    if (!isValidEmail(normalizedEmail) || isGuestEmail(normalizedEmail)) {
      return NextResponse.json({ error: t('api.auth.resetLinkInvalid') }, { status: 400 });
    }

    const passwordError = getPasswordValidationError(password, locale);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const outcome = await prisma.$transaction(async (tx) => {
      // Lock the user row before consuming reset tokens so reset, password change, and account
      // deletion always lock `users` before `password_reset_tokens` and cannot deadlock.
      const lockedUsers = await tx.$queryRaw<
        Array<{ id: string; emailVerified: Date | null; isGuest: boolean }>
      >`
        SELECT id, "emailVerified", "isGuest" FROM users WHERE email = ${normalizedEmail} FOR UPDATE
      `;
      const user = lockedUsers[0];
      // A guest row has no reset path: the DB label decides, not the placeholder address alone.
      if (!user || user.isGuest) {
        return { ok: false as const, reason: t('api.auth.resetLinkInvalid') };
      }

      const result = await consumePasswordResetToken(normalizedEmail, token, tx);
      if (!result.success) {
        return { ok: false as const, reason: result.reason };
      }

      await tx.user.update({
        where: { id: user.id },
        data: { password: hashedPassword, emailVerified: user.emailVerified || new Date() },
      });

      // Clear any remaining reset tokens for this email so stale links cannot be reused.
      await tx.passwordResetToken.deleteMany({
        where: { email: normalizedEmail },
      });

      return { ok: true as const };
    });

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.reason }, { status: 400 });
    }

    return NextResponse.json({ message: t('api.auth.passwordUpdated') });
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json({ error: t('api.auth.resetFailed') }, { status: 500 });
  }
}
