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
});
