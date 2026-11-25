import { describe, expect, it } from 'vitest';
import {
  MODAL_FOOTER_DB,
  modalFooterDatabaseUrl,
  requireModalFooterDatabaseUrl,
} from '../../tests/e2e/fixtures/modal-footer-db-config';

const FIXTURE_URL = `postgresql://${MODAL_FOOTER_DB.username}:${MODAL_FOOTER_DB.password}@127.0.0.1:55432/clickmoji_modal_footer_test`;

describe('modal-footer fixture database guard', () => {
  it('treats an unset or blank variable as no fixture database', () => {
    expect(modalFooterDatabaseUrl(undefined)).toBeNull();
    expect(modalFooterDatabaseUrl('')).toBeNull();
    expect(modalFooterDatabaseUrl('   ')).toBeNull();
  });

  it('accepts exactly the loopback fixture database', () => {
    expect(modalFooterDatabaseUrl(FIXTURE_URL)).toBe(FIXTURE_URL);
    expect(modalFooterDatabaseUrl(`  ${FIXTURE_URL}  `)).toBe(FIXTURE_URL);
  });

  it('requires a configured fixture database for admin scenarios instead of skipping', () => {
    expect(() => requireModalFooterDatabaseUrl(undefined)).toThrow(
      /need MODAL_FOOTER_TEST_DATABASE_URL/
    );
    expect(requireModalFooterDatabaseUrl(FIXTURE_URL)).toBe(FIXTURE_URL);
  });

  it.each([
    ['a working or deployed host', FIXTURE_URL.replace('127.0.0.1', 'db.example.com')],
    [
      'localhost instead of the exact loopback address',
      FIXTURE_URL.replace('127.0.0.1', 'localhost'),
    ],
    ['IPv6 loopback', FIXTURE_URL.replace('127.0.0.1', '[::1]')],
    ['the developer port 5432', FIXTURE_URL.replace(':55432', ':5432')],
    ['a missing port', FIXTURE_URL.replace(':55432', '')],
    [
      'a different database name',
      FIXTURE_URL.replace('clickmoji_modal_footer_test', 'clickmoji_ci'),
    ],
    [
      'a prefix-extended database name',
      FIXTURE_URL.replace('clickmoji_modal_footer_test', 'clickmoji_modal_footer_test2'),
    ],
    [
      'the postgres maintenance database',
      FIXTURE_URL.replace('clickmoji_modal_footer_test', 'postgres'),
    ],
    ['a host override in the query', `${FIXTURE_URL}?host=db.example.com`],
    ['a fragment', `${FIXTURE_URL}#x`],
    ['another user', FIXTURE_URL.replace(MODAL_FOOTER_DB.username, 'postgres')],
    ['another password', FIXTURE_URL.replace(`:${MODAL_FOOTER_DB.password}@`, ':postgres@')],
    ['a non-postgres scheme', FIXTURE_URL.replace('postgresql:', 'mysql:')],
    ['a value that is not a URL', 'not a url'],
  ])('refuses %s', (_label, raw) => {
    expect(() => modalFooterDatabaseUrl(raw)).toThrow(/Refusing|not a valid URL/);
  });

  it('never echoes the password in a refusal', () => {
    const sentinel = 'SENTINEL-not-a-real-password';
    const url = new URL(FIXTURE_URL);
    url.password = sentinel;
    const refusal = (() => {
      try {
        modalFooterDatabaseUrl(url.toString());
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(refusal).toMatch(/^Refusing /);
    expect(refusal).not.toContain(sentinel);
  });
});
