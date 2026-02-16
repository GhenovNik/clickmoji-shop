import { handlers } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/auth-security';

export const GET = handlers.GET;

export async function POST(request: NextRequest) {
  const pathname = new URL(request.url).pathname;

  if (pathname.endsWith('/callback/credentials')) {
    const limit = checkRateLimit({
      key: `auth:login:ip:${getClientIp(request)}`,
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });

    if (!limit.allowed) {
      return rateLimitResponse(limit.resetAt);
    }
  }

  return handlers.POST(request);
}
