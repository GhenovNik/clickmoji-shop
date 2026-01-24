import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createEmailVerificationToken } from '@/lib/auth-tokens';
import { sendVerificationEmail } from '@/lib/email';

export async function POST(request: Request) {
  try {
    const { email } = await request.json();

    if (!email) {
      return NextResponse.json({ error: 'Email обязателен' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.emailVerified) {
      return NextResponse.json({ message: 'Если адрес существует, письмо отправлено' });
    }

    const token = await createEmailVerificationToken(email);
    await sendVerificationEmail({ email, token });

    return NextResponse.json({ message: 'Письмо отправлено' });
  } catch (error) {
    console.error('Resend verification error:', error);
    return NextResponse.json({ error: 'Не удалось отправить письмо' }, { status: 500 });
  }
}
