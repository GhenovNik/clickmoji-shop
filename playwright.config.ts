import { defineConfig, devices } from '@playwright/test';

const chromiumChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL;

export default defineConfig({
  testDir: './tests/e2e',
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
    env: {
      AUTH_SECRET: 'age-1541-local-only',
      NEXTAUTH_SECRET: 'age-1541-local-only',
      DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/modal-footer?connect_timeout=1',
    },
    command:
      'npm run build && PLAYWRIGHT_AUTH_BYPASS=1 PLAYWRIGHT_AUTH_BYPASS_TOKEN=e2e-auth-bypass npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
