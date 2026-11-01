import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createPasswordResetToken } from '@/lib/auth-tokens';
import { sendPasswordResetEmail } from '@/lib/email';
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
    const { email } = await request.json();
    const normalizedEmail = normalizeEmail(email || '');
    const ip = getClientIp(request);

    const ipLimit = await checkRateLimit({
      key: `auth:forgot:ip:${ip}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.resetAt, locale);
    }

    const emailLimit = await checkRateLimit({
      key: `auth:forgot:email:${normalizedEmail || 'missing'}`,
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!emailLimit.allowed) {
      return rateLimitResponse(emailLimit.resetAt, locale);
    }

    if (!normalizedEmail) {
      return NextResponse.json({ error: t('api.auth.emailRequired') }, { status: 400 });
    }

    if (!isValidEmail(normalizedEmail)) {
      return NextResponse.json({ message: t('api.auth.emailSentIfExists') });
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user) {
      return NextResponse.json({ message: t('api.auth.emailSentIfExists') });
    }

    const token = await createPasswordResetToken(normalizedEmail);
    await sendPasswordResetEmail({ email: normalizedEmail, token, locale });

    return NextResponse.json({ message: t('api.auth.emailSentIfExists') });
  } catch (error) {
    console.error('Forgot password error:', error);
    return NextResponse.json({ error: t('api.auth.emailSendFailed') }, { status: 500 });
  }
}
