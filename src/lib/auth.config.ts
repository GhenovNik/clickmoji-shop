import type { NextAuthConfig } from 'next-auth';

export const authConfig: NextAuthConfig = {
  pages: {
    signIn: '/login',
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const pathname = nextUrl.pathname;

      // Публичные маршруты
      const publicRoutes = ['/', '/login', '/register'];
      const isPublicRoute = publicRoutes.includes(pathname);

      // API маршруты - пропускаем
      if (pathname.startsWith('/api')) {
        return true;
      }

      // Если пользователь не авторизован и пытается попасть на защищенный маршрут
      if (!isLoggedIn && !isPublicRoute) {
        return false; // Редирект на /login
      }

      // Если пользователь авторизован и пытается попасть на страницу входа/регистрации
      if (isLoggedIn && (pathname === '/login' || pathname === '/register')) {
        return Response.redirect(new URL('/', nextUrl));
      }

      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
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
  providers: [], // Providers добавляются в auth.ts
  session: {
    strategy: 'jwt',
  },
};
