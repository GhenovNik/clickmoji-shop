import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { consumePasswordResetToken } from '@/lib/auth-tokens';
import { getPasswordValidationError } from '@/lib/validation/password';
import {
  checkRateLimit,
  getClientIp,
  isValidEmail,
  normalizeEmail,
  rateLimitResponse,
} from '@/lib/auth-security';

export async function POST(request: Request) {
  try {
    const { email, token, password } = await request.json();
    const normalizedEmail = normalizeEmail(email || '');
    const ip = getClientIp(request);

    const ipLimit = checkRateLimit({
      key: `auth:reset:ip:${ip}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.resetAt);
    }

    if (!normalizedEmail || !token || !password) {
      return NextResponse.json({ error: 'Email, token и пароль обязательны' }, { status: 400 });
    }

    if (!isValidEmail(normalizedEmail)) {
      return NextResponse.json({ error: 'Ссылка для сброса недействительна.' }, { status: 400 });
    }

    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const result = await consumePasswordResetToken(normalizedEmail, token);
    if (!result.success) {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      return NextResponse.json({ error: 'Ссылка для сброса недействительна.' }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { email: normalizedEmail },
      data: { password: hashedPassword, emailVerified: user.emailVerified || new Date() },
    });

    return NextResponse.json({ message: 'Пароль обновлен' });
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json({ error: 'Не удалось сбросить пароль' }, { status: 500 });
  }
}
