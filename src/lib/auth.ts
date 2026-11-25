import { getServerSession, type NextAuthOptions } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';
import { authConfig } from './auth.config';
import { isEmailVerificationRequired } from './email';
import { normalizeEmail } from './auth-security';
import { readGuestIdFromRequestScope, recordFunnelEvent } from './funnel';
import { isGuestEmail, isSessionTokenFreshForUser } from './guest';

const providers: NextAuthOptions['providers'] = [
  Credentials({
    name: 'credentials',
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) {
        return null;
      }

      const email = normalizeEmail(credentials.email as string);
      const password = credentials.password as string;

      if (isGuestEmail(email)) {
        return null;
      }

      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user || user.isGuest || !user.password) {
        return null;
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        return null;
      }

      if (isEmailVerificationRequired() && !user.emailVerified) {
        throw new Error('EmailNotVerified');
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        role: user.role,
        isGuest: user.isGuest,
      };
    },
  }),
];

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
}

export const authOptions: NextAuthOptions = {
  ...authConfig,
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'google') {
        if (user?.id) {
          const guestId = await readGuestIdFromRequestScope();
          await recordFunnelEvent({
            type: 'LOGIN',
            userId: user.id,
            guestId,
            correlateGuest: true,
          });
        }
        return true;
      }

      const email = normalizeEmail((user.email || profile?.email || '') as string);
      if (!email || isGuestEmail(email)) {
        return false;
      }

      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser?.isGuest) {
        return false;
      }

      let authenticatedUserId: string;
      let authenticatedRole = 'USER';
      let isNewUser = false;

      if (!existingUser) {
        const createdUser = await prisma.user.create({
          data: {
            email,
            name: user.name || null,
            image: user.image || null,
            password: null,
            emailVerified: new Date(),
          },
        });
        authenticatedUserId = createdUser.id;
        authenticatedRole = createdUser.role ?? 'USER';
        isNewUser = true;
      } else {
        await prisma.user.update({
          where: { email },
          data: {
            name: existingUser.name || user.name || null,
            image: user.image || existingUser.image,
            emailVerified: existingUser.emailVerified || new Date(),
            password: existingUser.emailVerified ? undefined : null,
          },
        });
        authenticatedUserId = existingUser.id;
        authenticatedRole = existingUser.role ?? 'USER';
      }

      user.id = authenticatedUserId;
      (user as typeof user & { role?: string; isGuest?: boolean }).role = authenticatedRole;
      (user as typeof user & { isGuest?: boolean }).isGuest = false;

      const guestId = await readGuestIdFromRequestScope();
      await recordFunnelEvent({
        type: isNewUser ? 'REGISTER' : 'LOGIN',
        userId: authenticatedUserId,
        guestId,
        correlateGuest: true,
      });

      return true;
    },
    async jwt({ token, user, account }) {
      if (user) {
        if (account?.provider === 'google' && user.email) {
          const dbUser = await prisma.user.findUnique({
            where: { email: normalizeEmail(user.email) },
            select: { id: true, role: true, email: true, isGuest: true },
          });
          if (!dbUser || dbUser.isGuest) {
            throw new Error('Invalid OAuth user');
          }
          token.id = dbUser.id;
          token.role = dbUser.role;
          token.email = dbUser.email;
          token.isGuest = dbUser.isGuest;
          return token;
        }

        token.id = user.id;
        token.role = (user as typeof user & { role?: string }).role ?? 'USER';
        token.email = user.email;
        token.isGuest = Boolean((user as typeof user & { isGuest?: boolean }).isGuest);
        return token;
      }

      // Existing session refresh: identify strictly by User.id (never email fallback) and verify
      // the JWT was issued at or after that row's creation second so deleted/recreated rows cannot
      // inherit an older session.
      if (typeof token.id !== 'string' || !token.id) {
        throw new Error('Session token missing user id');
      }

      const dbUser = await prisma.user.findUnique({
        where: { id: token.id },
        select: { id: true, role: true, email: true, isGuest: true, createdAt: true },
      });

      if (
        !dbUser ||
        !isSessionTokenFreshForUser(token.iat as number | undefined, dbUser.createdAt)
      ) {
        throw new Error('Session user no longer valid');
      }

      token.id = dbUser.id;
      token.role = dbUser.role;
      token.email = dbUser.email;
      token.isGuest = dbUser.isGuest;

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.isGuest = Boolean(token.isGuest);
      }
      if (typeof token.iat === 'number') {
        session.tokenIssuedAt = token.iat;
      }
      return session;
    },
  },
  providers,
};

export function auth() {
  return getServerSession(authOptions);
}
