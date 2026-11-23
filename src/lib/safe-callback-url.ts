// The return address after sign-in stays on this site: one leading slash, no control
// characters (the WHATWG parser silently strips them and would land off-site), and the
// parsed address must keep the site's origin. The base origin is fixed, not environmental:
// only same-origin comparison uses it, so its value never leaks into the returned path.
const SITE_ORIGIN = 'http://localhost';

export function safeCallbackUrl(value: string | null | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  if (value.startsWith('/\\')) return '/';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return '/';
  }
  let url: URL;
  try {
    url = new URL(value, SITE_ORIGIN);
  } catch {
    return '/';
  }
  if (url.origin !== SITE_ORIGIN) return '/';
  const result = url.pathname + url.search + url.hash;
  // The parser resolves dot segments after percent-decoding, so the result itself must be
  // checked: it can begin with // or /\ even when the input did not.
  if (result.startsWith('//') || result.startsWith('/\\')) return '/';
  for (let i = 0; i < result.length; i++) {
    const code = result.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return '/';
  }
  let reparsed: URL;
  try {
    reparsed = new URL(result, SITE_ORIGIN);
  } catch {
    return '/';
  }
  if (reparsed.origin !== SITE_ORIGIN) return '/';
  if (reparsed.pathname + reparsed.search + reparsed.hash !== result) return '/';
  return result;
}
