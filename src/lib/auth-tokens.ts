import crypto from 'crypto';
import { prisma } from './prisma';
import { normalizeEmail } from './auth-security';

const EMAIL_TOKEN_TTL_HOURS = 24;
const PASSWORD_RESET_TTL_HOURS = 1;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export async function createEmailVerificationToken(email: string) {
  const normalizedEmail = normalizeEmail(email);
  const token = crypto.randomBytes(32).toString('hex');
  const hashedToken = hashToken(token);
  const expiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  await prisma.emailVerificationToken.deleteMany({
    where: {
      OR: [{ email: normalizedEmail }, { expiresAt: { lt: new Date() } }],
    },
  });

  await prisma.emailVerificationToken.create({
    data: {
      email: normalizedEmail,
      token: hashedToken,
      expiresAt,
    },
  });

  return token;
}

export async function consumeEmailVerificationToken(email: string, token: string) {
  const normalizedEmail = normalizeEmail(email);
  const hashedToken = hashToken(token);
  const record = await prisma.emailVerificationToken.findFirst({
    where: {
      email: normalizedEmail,
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
    where: { email: normalizedEmail },
    data: { emailVerified: new Date() },
  });

  await prisma.emailVerificationToken.delete({ where: { id: record.id } });

  return { success: true } as const;
}

export async function createPasswordResetToken(email: string) {
  const normalizedEmail = normalizeEmail(email);
  const token = crypto.randomBytes(32).toString('hex');
  const hashedToken = hashToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * 60 * 60 * 1000);

  await prisma.passwordResetToken.deleteMany({
    where: {
      OR: [{ email: normalizedEmail }, { expiresAt: { lt: new Date() } }],
    },
  });

  await prisma.passwordResetToken.create({
    data: {
      email: normalizedEmail,
      token: hashedToken,
      expiresAt,
    },
  });

  return token;
}

export async function consumePasswordResetToken(email: string, token: string) {
  const normalizedEmail = normalizeEmail(email);
  const hashedToken = hashToken(token);
  const record = await prisma.passwordResetToken.findFirst({
    where: {
      email: normalizedEmail,
      token: hashedToken,
    },
  });

  if (!record) {
    return { success: false, reason: 'invalid' } as const;
  }

  if (record.expiresAt < new Date()) {
    await prisma.passwordResetToken.delete({ where: { id: record.id } });
    return { success: false, reason: 'expired' } as const;
  }

  await prisma.passwordResetToken.delete({ where: { id: record.id } });

  return { success: true } as const;
}
