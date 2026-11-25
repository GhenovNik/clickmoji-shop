import { getServerSession, type NextAuthOptions } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';
import { authConfig } from './auth.config';
import { isEmailVerificationRequired } from './email';
import { normalizeEmail } from './auth-security';
import { readSessionClaims, SESSION_ISSUED_AT_CLAIM } from './auth-session';
import { readGuestIdFromRequestScope, recordFunnelEvent } from './funnel';

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

      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user || !user.password) {
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
      if (!email) {
        return false;
      }

      const existingUser = await prisma.user.findUnique({ where: { email } });
      let authenticatedUserId: string;
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
      }

      // NextAuth passes this same object to the jwt callback on sign-in; the token must carry
      // the DB id of the account that was just authorised, not the Google subject.
      user.id = authenticatedUserId;

      const guestId = await readGuestIdFromRequestScope();
      await recordFunnelEvent({
        type: isNewUser ? 'REGISTER' : 'LOGIN',
        userId: authenticatedUserId,
        guestId,
        correlateGuest: true,
      });

      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        // Sign-in only: bind the token once to the account id and stamp its issuance in ms.
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { role: true },
        });
        if (!dbUser) {
          throw new Error('InvalidSession');
        }
        token.id = user.id;
        token.email = user.email;
        token.role = dbUser.role;
        token[SESSION_ISSUED_AT_CLAIM] = Date.now();
        return token;
      }

      // Refresh: the token must still name a live account issued after that account was created.
      // Throwing makes NextAuth's session route drop the cookie and treat the session as absent.
      const claims = readSessionClaims(token);
      if (!claims) {
        throw new Error('InvalidSession');
      }

      const dbUser = await prisma.user.findUnique({
        where: { id: claims.id },
        select: { role: true, createdAt: true },
      });
      if (!dbUser || dbUser.createdAt.getTime() > claims.authIssuedAt) {
        throw new Error('InvalidSession');
      }

      token.role = dbUser.role;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
      }
      return session;
    },
  },
  providers,
};

export function auth() {
  return getServerSession(authOptions);
}
