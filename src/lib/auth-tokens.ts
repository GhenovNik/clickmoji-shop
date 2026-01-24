import crypto from 'crypto';
import { prisma } from './prisma';

const EMAIL_TOKEN_TTL_HOURS = 24;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export async function createEmailVerificationToken(email: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const hashedToken = hashToken(token);
  const expiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  await prisma.emailVerificationToken.deleteMany({
    where: {
      OR: [{ email }, { expiresAt: { lt: new Date() } }],
    },
  });

  await prisma.emailVerificationToken.create({
    data: {
      email,
      token: hashedToken,
      expiresAt,
    },
  });

  return token;
}

export async function consumeEmailVerificationToken(email: string, token: string) {
  const hashedToken = hashToken(token);
  const record = await prisma.emailVerificationToken.findFirst({
    where: {
      email,
      token: hashedToken,
    },
  });

  if (!record) {
    return { success: false, reason: 'invalid' } as const;
  }

  if (record.expiresAt < new Date()) {
    await prisma.emailVerificationToken.delete({ where: { id: record.id } });
    return { success: false, reason: 'expired' } as const;
  }

  await prisma.user.update({
    where: { email },
    data: { emailVerified: new Date() },
  });

  await prisma.emailVerificationToken.delete({ where: { id: record.id } });

  return { success: true } as const;
}
