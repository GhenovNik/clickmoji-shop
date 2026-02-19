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
const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

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

async function checkRateLimitUpstash({ key, limit, windowMs }: RateLimitOptions) {
  if (!upstashUrl || !upstashToken) {
    return null;
  }

  const response = await fetch(`${upstashUrl}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${upstashToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      ['PTTL', key],
      ['PEXPIRE', key, windowMs, 'NX'],
    ]),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Upstash rate limit request failed with status ${response.status}`);
  }

  const data = (await response.json()) as Array<{ result?: number; error?: string }>;
  const count = Number(data[0]?.result ?? 0);
  const ttl = Number(data[1]?.result ?? -1);
  const now = Date.now();
  const resetAt = now + (ttl > 0 ? ttl : windowMs);

  if (count > limit) {
    return { allowed: false as const, remaining: 0, resetAt };
  }

  return {
    allowed: true as const,
    remaining: Math.max(limit - count, 0),
    resetAt,
  };
}

function checkRateLimitMemory({ key, limit, windowMs }: RateLimitOptions) {
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

export async function checkRateLimit(options: RateLimitOptions) {
  try {
    const distributed = await checkRateLimitUpstash(options);
    if (distributed) {
      return distributed;
    }
  } catch (error) {
    console.error('Distributed rate limit failed, using memory fallback:', error);
  }

  return checkRateLimitMemory(options);
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
