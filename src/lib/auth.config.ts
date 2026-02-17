import type { NextAuthOptions } from 'next-auth';

export const authConfig: Pick<NextAuthOptions, 'secret' | 'pages' | 'session'> = {
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
  },
};
