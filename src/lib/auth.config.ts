import type { NextAuthConfig } from 'next-auth';

export const authConfig: NextAuthConfig = {
  trustHost: true,
  pages: {
    signIn: '/login',
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const pathname = nextUrl.pathname;
      const userRole = auth?.user?.role;

      // Публичные маршруты
      const publicRoutes = ['/', '/login', '/register', '/forgot-password', '/reset-password'];
      const isPublicRoute = publicRoutes.includes(pathname);

      // API маршруты - пропускаем (проверка роли будет в самих API)
      if (pathname.startsWith('/api')) {
        return true;
      }

      // Проверка доступа к админ-панели
      if (pathname.startsWith('/admin')) {
        if (!isLoggedIn) {
          return false; // Редирект на /login
        }
        if (userRole !== 'ADMIN') {
          return Response.redirect(new URL('/', nextUrl));
        }
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
