import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { consumePasswordResetToken } from '@/lib/auth-tokens';
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

    if (!isValidEmail(normalizedEmail)) {
      return NextResponse.json({ error: t('api.auth.resetLinkInvalid') }, { status: 400 });
    }

    const passwordError = getPasswordValidationError(password, locale);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const result = await consumePasswordResetToken(normalizedEmail, token);
    if (!result.success) {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      return NextResponse.json({ error: t('api.auth.resetLinkInvalid') }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { email: normalizedEmail },
      data: { password: hashedPassword, emailVerified: user.emailVerified || new Date() },
    });

    return NextResponse.json({ message: t('api.auth.passwordUpdated') });
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json({ error: t('api.auth.resetFailed') }, { status: 500 });
  }
}
