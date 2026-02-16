import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { createEmailVerificationToken } from '@/lib/auth-tokens';
import { isEmailVerificationRequired, sendVerificationEmail } from '@/lib/email';
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
    const { email, password, name } = await request.json();
    const normalizedEmail = normalizeEmail(email || '');
    const ip = getClientIp(request);

    const ipLimit = checkRateLimit({
      key: `auth:register:ip:${ip}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.resetAt);
    }

    const emailLimit = checkRateLimit({
      key: `auth:register:email:${normalizedEmail || 'missing'}`,
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!emailLimit.allowed) {
      return rateLimitResponse(emailLimit.resetAt);
    }

    if (!normalizedEmail || !password) {
      return NextResponse.json({ error: 'Email и пароль обязательны' }, { status: 400 });
    }

    if (!isValidEmail(normalizedEmail)) {
      return NextResponse.json({ error: 'Некорректный email' }, { status: 400 });
    }

    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    // Проверка существующего пользователя
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: 'Пользователь с таким email уже существует' },
        { status: 400 }
      );
    }

    // Хеширование пароля
    const hashedPassword = await bcrypt.hash(password, 12);

    const requiresEmailVerification = isEmailVerificationRequired();

    // Создание пользователя
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
        await sendVerificationEmail({ email: normalizedEmail, token });
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

        return NextResponse.json(
          { error: 'Не удалось отправить письмо подтверждения. Попробуйте позже.' },
          { status: 503 }
        );
      }
    }

    // Создание базовых списков покупок для пользователя
    const defaultLists = [
      { name: 'Основной', isActive: true },
      { name: 'На выходные', isActive: false },
      { name: 'Праздники', isActive: false },
      { name: 'Для вечеринки', isActive: false },
      { name: 'Срочное', isActive: false },
    ];

    await prisma.list.createMany({
      data: defaultLists.map((list) => ({
        ...list,
        userId: user.id,
      })),
    });

    return NextResponse.json(
      {
        message: 'Пользователь успешно создан',
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
    return NextResponse.json({ error: 'Ошибка при регистрации' }, { status: 500 });
  }
}
