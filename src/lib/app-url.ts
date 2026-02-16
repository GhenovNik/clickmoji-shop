const LOCAL_FALLBACK_URL = 'http://localhost:3000';

function normalizeBaseUrl(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function getAppBaseUrl(): string {
  const candidates = [
    process.env.AUTH_URL,
    process.env.NEXTAUTH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return LOCAL_FALLBACK_URL;
}
