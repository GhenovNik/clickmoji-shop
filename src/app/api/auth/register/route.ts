import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { createEmailVerificationToken } from '@/lib/auth-tokens';
import { sendVerificationEmail } from '@/lib/email';
import { getPasswordValidationError } from '@/lib/validation/password';

export async function POST(request: Request) {
  try {
    const { email, password, name } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email и пароль обязательны' }, { status: 400 });
    }

    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    // Проверка существующего пользователя
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: 'Пользователь с таким email уже существует' },
        { status: 400 }
      );
    }

    // Хеширование пароля
    const hashedPassword = await bcrypt.hash(password, 12);

    // Создание пользователя
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name || null,
      },
    });

    let emailSent = false;
    try {
      const token = await createEmailVerificationToken(email);
      await sendVerificationEmail({ email, token });
      emailSent = true;
    } catch (emailError) {
      console.error('Verification email error:', emailError);
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
