import { defineConfig, devices } from '@playwright/test';
import {
  MODAL_FOOTER_AUTH_SECRET,
  MODAL_FOOTER_DB_ENV,
  MODAL_FOOTER_UNREACHABLE_DATABASE_URL,
  modalFooterDatabaseUrl,
} from './tests/e2e/fixtures/modal-footer-db-config';

const chromiumChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL;
// Validated at config load, before any server or database connection. Only the loopback
// fixture database is accepted; a set but unsafe value stops the run here.
const modalFooterDatabase = modalFooterDatabaseUrl(process.env[MODAL_FOOTER_DB_ENV]);

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/fixtures/modal-footer-global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    // The specs assert the Russian UI; English is covered in tests/e2e/language.spec.ts.
    locale: 'ru-RU',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumChannel ? { channel: chromiumChannel } : {}),
      },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'modal-webkit',
      testMatch: 'modal-footer.spec.ts',
      use: { browserName: 'webkit' },
    },
  ],

  webServer: {
    timeout: 180_000,
    // Public local-only fixture values: admin UI is exercised via signed NextAuth
    // cookies, while every API request is mocked. Never use application credentials.
    // The fixture database is the validated loopback one or, when unset, a closed port.
    env: {
      AUTH_SECRET: MODAL_FOOTER_AUTH_SECRET,
      NEXTAUTH_SECRET: MODAL_FOOTER_AUTH_SECRET,
      DATABASE_URL: modalFooterDatabase ?? MODAL_FOOTER_UNREACHABLE_DATABASE_URL,
    },
    command:
      'npm run build && PLAYWRIGHT_AUTH_BYPASS=1 PLAYWRIGHT_AUTH_BYPASS_TOKEN=e2e-auth-bypass npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
