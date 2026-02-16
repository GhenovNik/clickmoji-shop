import { NextResponse } from 'next/server';

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimitOptions = {
  key: string;
  limit: number;
  windowMs: number;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const rateLimitStore = new Map<string, RateLimitEntry>();
let lastCleanup = Date.now();

function cleanupRateLimitStore(now: number) {
  if (now - lastCleanup < 60_000) {
    return;
  }

  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
  lastCleanup = now;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const [first] = forwarded.split(',');
    if (first?.trim()) {
      return first.trim();
    }
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp?.trim()) {
    return realIp.trim();
  }

  return 'unknown';
}

export function checkRateLimit({ key, limit, windowMs }: RateLimitOptions) {
  const now = Date.now();
  cleanupRateLimitStore(now);

  const current = rateLimitStore.get(key);
  if (!current || current.resetAt <= now) {
    const resetAt = now + windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true as const, remaining: limit - 1, resetAt };
  }

  if (current.count >= limit) {
    return { allowed: false as const, remaining: 0, resetAt: current.resetAt };
  }

  current.count += 1;
  rateLimitStore.set(key, current);

  return {
    allowed: true as const,
    remaining: Math.max(limit - current.count, 0),
    resetAt: current.resetAt,
  };
}

export function rateLimitResponse(resetAt: number) {
  const retryAfter = Math.max(Math.ceil((resetAt - Date.now()) / 1000), 1);
  return NextResponse.json(
    { error: 'Слишком много попыток. Попробуйте позже.' },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfter),
      },
    }
  );
}
