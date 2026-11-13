import { describe, expect, it } from 'vitest';
import { safeCallbackUrl } from './safe-callback-url';

// AGE-1618 FR-3: the return address after sign-in must stay on this site.

describe('safeCallbackUrl', () => {
  it.each([
    'https://evil.example',
    'http://evil.example',
    'https://evil.example/login',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '/\\/evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '%2F%2Fevil.example',
    '\\\\evil.example',
    '',
    ' ',
  ])('rejects %j', (value) => {
    expect(safeCallbackUrl(value)).toBe('/');
  });

  it.each([null, undefined])('rejects a missing value (%j)', (value) => {
    expect(safeCallbackUrl(value)).toBe('/');
  });

  it.each([
    '/',
    '/categories/c1/products',
    '/categories/c1/products?listId=l1',
    '/a?b=c&d=e',
    '/%2Fevil.example',
  ])('keeps the site-relative path %j', (value) => {
    expect(safeCallbackUrl(value)).toBe(value);
  });

  // AGE-1618 FR-3 AC-8: control characters anywhere in the value reject it, even though the
  // WHATWG URL parser would strip them and land on an external host.
  it.each([
    ['tab', '/\t/evil.example'],
    ['line feed', '/\n/evil.example'],
    ['carriage return before backslash', '/\r\\evil.example'],
    ['nul', '/\u0000x'],
    ['delete', '/a\u007f'],
  ])('rejects a control character (%s)', (_label, value) => {
    expect(safeCallbackUrl(value)).toBe('/');
  });

  // AGE-1618 FR-3 AC-8: what the URL parser keeps of the site path is returned, nothing more.
  it.each([
    ['path with query and hash', '/categories/c1/products?x=1#h', '/categories/c1/products?x=1#h'],
    ['percent-encoded slashes stay a site path', '/%2F%2Fx', '/%2F%2Fx'],
  ])('keeps %s', (_label, value, expected) => {
    expect(safeCallbackUrl(value)).toBe(expected);
  });
});
