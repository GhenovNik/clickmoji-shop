import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { consumePasswordResetToken } from '@/lib/auth-tokens';
import { getPasswordValidationError } from '@/lib/validation/password';

export async function POST(request: Request) {
  try {
    const { email, token, password } = await request.json();

    if (!email || !token || !password) {
      return NextResponse.json({ error: 'Email, token и пароль обязательны' }, { status: 400 });
    }

    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const result = await consumePasswordResetToken(email, token);
    if (!result.success) {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { email },
      data: { password: hashedPassword },
    });

    return NextResponse.json({ message: 'Пароль обновлен' });
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json({ error: 'Не удалось сбросить пароль' }, { status: 500 });
  }
}
