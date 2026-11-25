// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readSessionClaims } from './auth-session';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

describe('readSessionClaims', () => {
  it('accepts a token with a DB id and a millisecond issuance time', () => {
    expect(readSessionClaims({ id: 'cuid_1', authIssuedAt: NOW - 1000 }, NOW)).toEqual({
      id: 'cuid_1',
      authIssuedAt: NOW - 1000,
    });
  });

  it('rejects a legacy token without the issuance claim', () => {
    expect(readSessionClaims({ id: 'cuid_1', email: 'a@b.c', iat: 1_700_000_000 }, NOW)).toBeNull();
  });

  it('rejects an issuance time given in seconds instead of milliseconds', () => {
    expect(
      readSessionClaims({ id: 'cuid_1', authIssuedAt: Math.floor(NOW / 1000) }, NOW)
    ).toBeNull();
  });

  it('rejects an issuance time in the future beyond clock skew', () => {
    expect(readSessionClaims({ id: 'cuid_1', authIssuedAt: NOW + 5 * 60_000 }, NOW)).toBeNull();
  });

  it('rejects a missing, empty or non-string id and non-numeric time', () => {
    expect(readSessionClaims({ authIssuedAt: NOW }, NOW)).toBeNull();
    expect(readSessionClaims({ id: '', authIssuedAt: NOW }, NOW)).toBeNull();
    expect(readSessionClaims({ id: 42, authIssuedAt: NOW }, NOW)).toBeNull();
    expect(readSessionClaims({ id: 'cuid_1', authIssuedAt: '2026-11-24' }, NOW)).toBeNull();
  });

  it('rejects a missing token', () => {
    expect(readSessionClaims(null, NOW)).toBeNull();
    expect(readSessionClaims(undefined, NOW)).toBeNull();
  });
});
