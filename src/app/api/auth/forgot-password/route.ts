import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createPasswordResetToken } from '@/lib/auth-tokens';
import { sendPasswordResetEmail } from '@/lib/email';

export async function POST(request: Request) {
  try {
    const { email } = await request.json();

    if (!email) {
      return NextResponse.json({ error: 'Email обязателен' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return NextResponse.json({ message: 'Если адрес существует, письмо отправлено' });
    }

    const token = await createPasswordResetToken(email);
    await sendPasswordResetEmail({ email, token });

    return NextResponse.json({ message: 'Если адрес существует, письмо отправлено' });
  } catch (error) {
    console.error('Forgot password error:', error);
    return NextResponse.json({ error: 'Не удалось отправить письмо' }, { status: 500 });
  }
}
