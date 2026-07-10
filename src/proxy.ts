import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/auth-security';

const publicRoutes = [
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/manifest.json',
  '/sw.js',
  '/offline.html',
  '/icon.svg',
  '/robots.txt',
  '/sitemap.xml',
];

const isPublicCatalogRoute = (pathname: string) => {
  if (pathname === '/categories') {
    return true;
  }

  return /^\/categories\/[^/]+\/products$/.test(pathname);
};

const hasPlaywrightAuthBypass = (request: NextRequest) => {
  const bypassToken = process.env.PLAYWRIGHT_AUTH_BYPASS_TOKEN;

  return (
    process.env.PLAYWRIGHT_AUTH_BYPASS === '1' &&
    Boolean(bypassToken) &&
    request.cookies.get('clickmoji-e2e-auth')?.value === bypassToken
  );
};

export default async function proxy(request: NextRequest) {
  const { nextUrl } = request;
  const pathname = nextUrl.pathname;

  if (pathname.endsWith('/api/auth/callback/credentials')) {
    const limit = await checkRateLimit({
      key: `auth:login:ip:${getClientIp(request)}`,
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });

    if (!limit.allowed) {
      return rateLimitResponse(limit.resetAt);
    }
  }

  if (pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
  });

  const hasE2EAuth = hasPlaywrightAuthBypass(request);
  const isLoggedIn = Boolean(token) || hasE2EAuth;
  const userRole = hasE2EAuth ? 'USER' : (token?.role as string | undefined);
  const isPublicRoute = publicRoutes.includes(pathname) || isPublicCatalogRoute(pathname);

  if (pathname.startsWith('/admin')) {
    if (!isLoggedIn) {
      const loginUrl = new URL('/login', request.url);
      return NextResponse.redirect(loginUrl);
    }

    if (userRole !== 'ADMIN') {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  if (!isLoggedIn && !isPublicRoute) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (isLoggedIn && (pathname === '/login' || pathname === '/register')) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.json|sw.js|offline.html|robots.txt|sitemap.xml).*)',
  ],
};
