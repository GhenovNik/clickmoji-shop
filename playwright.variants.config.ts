import 'dotenv/config';
import { defineConfig } from '@playwright/test';

// This opt-in suite writes only isolated fixtures to the restored local Docker DB.
// The regular mocked E2E suite does not require database credentials.
const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (!['localhost', '127.0.0.1'].includes(target.hostname) || (target.port || '5432') !== '5432') {
  throw new Error('Variant regression E2E requires local PostgreSQL on loopback:5432');
}
process.env.PLAYWRIGHT_LOCAL_DB = '1';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'variant-add.local.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3136',
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
    locale: 'ru-RU',
    trace: 'on',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'variant-chromium', use: { browserName: 'chromium' } },
    { name: 'variant-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'npm run build && npm run start -- --hostname 127.0.0.1 --port 3136',
    url: 'http://localhost:3136/api/auth/csrf',
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXTAUTH_URL: 'http://localhost:3136',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
    },
  },
});
