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

  // AGE-1618 FR-3 AC-11: the parser resolves dot segments after percent-decoding them, so the
  // final pathname can start with // even though the input did not; the result must be checked.
  it.each([
    ['dot-dot then double slash', '/..//evil.example'],
    ['nested dot-dot', '/a/..//evil.example'],
    ['percent-encoded dots', '/%2e%2e//evil.example'],
    ['dot-dot backslash', '/a/..\\/evil.example'],
  ])('returns / for %s', (_label, value) => {
    expect(safeCallbackUrl(value)).toBe('/');
  });

  it('keeps the site path that /a/%2E%2E/%2Fevil.example parses to (AC-11)', () => {
    expect(safeCallbackUrl('/a/%2E%2E/%2Fevil.example')).toBe('/%2Fevil.example');
  });

  // AGE-1618 FR-3 AC-11: the result itself must not start with // or /\ and must re-parse to
  // the same origin and the same path, whichever input produced it.
  const rejectedInputs = [
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
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r\\evil.example',
    '/\u0000x',
    '/a\u007f',
    '/..//evil.example',
    '/a/..//evil.example',
    '/%2e%2e//evil.example',
    '/a/..\\/evil.example',
    '/a/%2E%2E/%2Fevil.example',
  ];
  const siteOrigin = 'http://localhost';
  it.each(rejectedInputs.map((value) => [JSON.stringify(value), value]))(
    'result for %s stays on this site (AC-11)',
    (_label, value) => {
      const result = safeCallbackUrl(value);
      expect(result.startsWith('//')).toBe(false);
      expect(result.startsWith('/\\')).toBe(false);
      const reparsed = new URL(result, siteOrigin);
      expect(reparsed.origin).toBe(siteOrigin);
      expect(reparsed.pathname + reparsed.search + reparsed.hash).toBe(result);
    }
  );

  it.each([
    '/',
    '/categories/c1/products',
    '/categories/c1/products?listId=l1',
    '/a?b=c&d=e',
    '/%2Fevil.example',
    '/categories/c1/products?x=1#h',
    '/%2F%2Fx',
  ])('returns the allowed path %j unchanged (AC-11)', (value) => {
    const result = safeCallbackUrl(value);
    expect(result).toBe(value);
    const reparsed = new URL(result, siteOrigin);
    expect(reparsed.origin).toBe(siteOrigin);
    expect(reparsed.pathname + reparsed.search + reparsed.hash).toBe(result);
  });
});
