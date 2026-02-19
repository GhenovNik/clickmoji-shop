import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createEmailVerificationToken } from '@/lib/auth-tokens';
import { isEmailVerificationRequired, sendVerificationEmail } from '@/lib/email';
import {
  checkRateLimit,
  getClientIp,
  isValidEmail,
  normalizeEmail,
  rateLimitResponse,
} from '@/lib/auth-security';

export async function POST(request: Request) {
  try {
    if (!isEmailVerificationRequired()) {
      return NextResponse.json({ message: 'Подтверждение email не требуется' });
    }

    const { email } = await request.json();
    const normalizedEmail = normalizeEmail(email || '');
    const ip = getClientIp(request);

    const ipLimit = await checkRateLimit({
      key: `auth:resend:ip:${ip}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.resetAt);
    }

    const emailLimit = await checkRateLimit({
      key: `auth:resend:email:${normalizedEmail || 'missing'}`,
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!emailLimit.allowed) {
      return rateLimitResponse(emailLimit.resetAt);
    }

    if (!normalizedEmail) {
      return NextResponse.json({ error: 'Email обязателен' }, { status: 400 });
    }

    if (!isValidEmail(normalizedEmail)) {
      return NextResponse.json({ message: 'Если адрес существует, письмо отправлено' });
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user || user.emailVerified) {
      return NextResponse.json({ message: 'Если адрес существует, письмо отправлено' });
    }

    const token = await createEmailVerificationToken(normalizedEmail);
    await sendVerificationEmail({ email: normalizedEmail, token });

    return NextResponse.json({ message: 'Письмо отправлено' });
  } catch (error) {
    console.error('Resend verification error:', error);
    return NextResponse.json({ error: 'Не удалось отправить письмо' }, { status: 500 });
  }
}
