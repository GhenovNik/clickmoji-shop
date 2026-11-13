// The return address after sign-in stays on this site: one leading slash, never a
// scheme-relative or backslash-relative path, so the browser cannot be sent off-site.
export function safeCallbackUrl(value: string | null | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  if (value.startsWith('/\\')) return '/';
  return value;
}
