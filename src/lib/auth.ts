import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import type { Provider } from 'next-auth/providers';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';
import { authConfig } from './auth.config';
import { isEmailVerificationRequired } from './email';
import { normalizeEmail } from './auth-security';

const providers: Provider[] = [
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

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'google') {
        return true;
      }

      const email = normalizeEmail((user.email || profile?.email || '') as string);
      if (!email) {
        return false;
      }

      const existingUser = await prisma.user.findUnique({ where: { email } });

      if (!existingUser) {
        await prisma.user.create({
          data: {
            email,
            name: user.name || null,
            image: user.image || null,
            password: null,
            emailVerified: new Date(),
          },
        });
      } else {
        await prisma.user.update({
          where: { email },
          data: {
            name: existingUser.name || user.name || null,
            image: user.image || existingUser.image,
            emailVerified: existingUser.emailVerified || new Date(),
          },
        });
      }

      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as typeof user & { role?: string }).role;
        token.email = user.email;
      }

      if (token.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: token.email as string },
        });
        if (dbUser) {
          token.id = dbUser.id;
          token.role = dbUser.role;
        }
      }

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
});
