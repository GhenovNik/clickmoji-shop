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
  FUNNEL_GUEST_MAX_AGE_SECONDS,
  mintGuestCredential,
  recordFunnelEvent,
  verifyGuestToken,
} from '@/lib/funnel';

const publicRoutes = [
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/terms',
  '/privacy',
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

/** Public pages a visitor can enter directly, without going through the homepage. */
const isFunnelEntryRoute = (pathname: string) =>
  pathname === '/' ||
  pathname === '/login' ||
  pathname === '/register' ||
  isPublicCatalogRoute(pathname);

/** A full document load: not a prefetch and not a client-side RSC navigation. */
const isDocumentGetRequest = (request: NextRequest) =>
  request.method === 'GET' && !isPrefetchRequest(request) && request.headers.get('rsc') !== '1';

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

  if (isFunnelEntryRoute(pathname) && isDocumentGetRequest(request)) {
    return recordEntryVisit(request, typeof token?.id === 'string' ? token.id : null);
  }

  return NextResponse.next();
}

/**
 * Records a VISIT for a direct document entry (homepage, login, register or public catalog).
 * Only a server-signed guest cookie is trusted; an absent or forged cookie is replaced with a new
 * minted one. Recording is best-effort and never blocks the page response.
 */
async function recordEntryVisit(request: NextRequest, userId: string | null) {
  const verifiedGuestId = verifyGuestToken(request.cookies.get(FUNNEL_GUEST_COOKIE)?.value);
  const minted = verifiedGuestId ? null : mintGuestCredential();
  const guestId = verifiedGuestId ?? minted?.guestId ?? null;

  await recordFunnelEvent({ type: 'VISIT', guestId, userId });

  const response = NextResponse.next();
  if (minted) {
    response.cookies.set(FUNNEL_GUEST_COOKIE, minted.cookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: FUNNEL_GUEST_MAX_AGE_SECONDS,
    });
  }
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.json|sw.js|offline.html|robots.txt|sitemap.xml|icons/icon-192\\.png$|icons/icon-512\\.png$|apple-touch-icon\\.png$).*)',
  ],
};
