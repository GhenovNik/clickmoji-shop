import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import {
  checkRateLimit,
  getClientIp,
  getRequestLocale,
  rateLimitResponse,
} from '@/lib/auth-security';
import {
  FUNNEL_GUEST_COOKIE,
  FUNNEL_GUEST_HEADER,
  FUNNEL_GUEST_MAX_AGE_SECONDS,
  generateGuestId,
  sanitizeGuestId,
} from '@/lib/funnel';

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
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/apple-touch-icon.png',
  '/robots.txt',
  '/sitemap.xml',
];

const isPublicCatalogRoute = (pathname: string) => {
  if (pathname === '/categories') {
    return true;
  }

  return /^\/categories\/[^/]+\/products$/.test(pathname);
};

const isPrefetchRequest = (request: NextRequest) =>
  request.headers.get('next-router-prefetch') === '1' ||
  request.headers.get('purpose') === 'prefetch' ||
  Boolean(request.headers.get('sec-purpose')?.toLowerCase().includes('prefetch'));

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
      return rateLimitResponse(limit.resetAt, getRequestLocale(request));
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

  if (pathname === '/' && request.method === 'GET' && !isPrefetchRequest(request)) {
    const existingGuestId = sanitizeGuestId(request.cookies.get(FUNNEL_GUEST_COOKIE)?.value);
    const guestId = existingGuestId ?? generateGuestId();
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(FUNNEL_GUEST_HEADER, guestId);

    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    if (!existingGuestId) {
      response.cookies.set(FUNNEL_GUEST_COOKIE, guestId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: FUNNEL_GUEST_MAX_AGE_SECONDS,
      });
    }

    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.json|sw.js|offline.html|robots.txt|sitemap.xml|icons/icon-192\\.png$|icons/icon-512\\.png$|apple-touch-icon\\.png$).*)',
  ],
};
