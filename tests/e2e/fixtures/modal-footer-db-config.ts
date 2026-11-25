// Test-only configuration for the modal-footer admin scenarios.
//
// Pure and dependency-free on purpose: playwright.config.ts, the global setup, the admin
// fixture and the vitest guard test all import it, and none of them may touch a database
// before the URL below has been checked.

/** Public test-only value. It signs only the local Playwright session cookie. */
export const MODAL_FOOTER_AUTH_SECRET = 'age-1541-local-only';

export const MODAL_FOOTER_DB_ENV = 'MODAL_FOOTER_TEST_DATABASE_URL';

/**
 * The single database the modal-footer harness may migrate or write to: a fixture Postgres
 * bound to loopback on a dedicated port. Anything else is refused before a connection exists.
 */
export const MODAL_FOOTER_DB = {
  username: 'modal_footer_fixture',
  password: 'modal_footer_fixture',
  hostname: '127.0.0.1',
  port: '55432',
  database: 'clickmoji_modal_footer_test',
} as const;

/**
 * Used when no fixture database is configured: local runs without PostgreSQL keep the
 * non-admin scenarios working, because those never reach the database. The port is closed.
 */
export const MODAL_FOOTER_UNREACHABLE_DATABASE_URL =
  'postgresql://fixture:fixture@127.0.0.1:1/modal-footer?connect_timeout=1';

/** The fixture admin row seeded by the global setup and bound into the session JWT. */
export const MODAL_FOOTER_ADMIN = {
  id: 'modal-footer-admin',
  email: 'modal-footer-admin@clickmoji.invalid',
  name: 'Modal fixture admin',
  // Fixed and in the past, so the account is always older than a freshly issued session.
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;

/**
 * Returns the normalised fixture database URL, `null` when none is configured, and throws
 * for any other value. The message never echoes the password.
 */
export function modalFooterDatabaseUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${MODAL_FOOTER_DB_ENV} is not a valid URL`);
  }

  const isFixtureDatabase =
    url.protocol === 'postgresql:' &&
    url.username === MODAL_FOOTER_DB.username &&
    url.password === MODAL_FOOTER_DB.password &&
    url.hostname === MODAL_FOOTER_DB.hostname &&
    url.port === MODAL_FOOTER_DB.port &&
    url.pathname === `/${MODAL_FOOTER_DB.database}` &&
    url.search === '' &&
    url.hash === '';

  if (!isFixtureDatabase) {
    throw new Error(
      `Refusing ${MODAL_FOOTER_DB_ENV}: only postgresql://${MODAL_FOOTER_DB.username}:***@${MODAL_FOOTER_DB.hostname}:${MODAL_FOOTER_DB.port}/${MODAL_FOOTER_DB.database} is allowed`
    );
  }

  return url.toString();
}

/** Admin scenarios cannot run without the fixture database, so they fail rather than skip. */
export function requireModalFooterDatabaseUrl(raw: string | undefined): string {
  const url = modalFooterDatabaseUrl(raw);
  if (!url) {
    throw new Error(
      `Admin modal-footer scenarios need ${MODAL_FOOTER_DB_ENV} (loopback fixture database, see playwright.config.ts)`
    );
  }
  return url;
}
